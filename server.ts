import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import { db } from "./src/lib/firebase"; // Relative TypeScript import resolved by tsx/esbuild
import { collection, doc, setDoc, getDoc, getDocs, query, orderBy } from "firebase/firestore";

// Setup dotenv
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// Lazy initialiser for GoogleGenAI
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error("GEMINI_API_KEY is not configured in the backend environment");
    }
    aiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  }
  return aiClient;
}

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Endpoint to fetch all data for a specific user to enable full persistence on refresh
app.get("/api/get-user-data/:userId", async (req, res) => {
  const { userId } = req.params;
  if (!userId) {
    return res.status(400).json({ error: "userId is required" });
  }

  try {
    // 1. Fetch Profile
    const profileDocRef = doc(db, "userProfiles", userId);
    const profileSnap = await getDoc(profileDocRef);
    const profile = profileSnap.exists() ? profileSnap.data() : null;

    // 2. Fetch Tasks
    const tasksColRef = collection(db, "userProfiles", userId, "tasks");
    const tasksSnap = await getDocs(tasksColRef);
    const tasks = tasksSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // 3. Fetch Schedules (ordered by createdAt if possible, or just all)
    const schedulesColRef = collection(db, "userProfiles", userId, "schedules");
    const schedulesSnap = await getDocs(schedulesColRef);
    const schedules = schedulesSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    res.json({ profile, tasks, schedules });
  } catch (error: any) {
    console.error("Error fetching user data:", error);
    res.status(500).json({ error: error.message || "Failed to fetch user data" });
  }
});

// Endpoint to save or update the User Profile
app.post("/api/save-profile", async (req, res) => {
  const { userId, role, dailyFreeHours, wakeUpTime, sleepTime, currentStartTime } = req.body;
  if (!userId || !role || dailyFreeHours === undefined || !wakeUpTime || !sleepTime) {
    return res.status(400).json({ error: "Missing required profile fields" });
  }

  try {
    const profileDocRef = doc(db, "userProfiles", userId);
    const profileData = {
      userId,
      role,
      dailyFreeHours: Number(dailyFreeHours),
      wakeUpTime,
      sleepTime,
      currentStartTime: currentStartTime || "",
      createdAt: new Date().toISOString()
    };
    await setDoc(profileDocRef, profileData);
    res.json({ success: true, profile: profileData });
  } catch (error: any) {
    console.error("Error saving profile:", error);
    res.status(500).json({ error: error.message || "Failed to save profile" });
  }
});

// Endpoint to save tasks
app.post("/api/save-tasks", async (req, res) => {
  const { userId, tasks } = req.body;
  if (!userId || !Array.isArray(tasks)) {
    return res.status(400).json({ error: "userId and tasks array are required" });
  }

  try {
    // Clear and re-save tasks for consistency, or update individually.
    // For simplicity, we write each task to its doc.
    for (const task of tasks) {
      const taskDocRef = doc(db, "userProfiles", userId, "tasks", task.id);
      await setDoc(taskDocRef, {
        id: task.id,
        userId,
        name: task.name,
        deadline: task.deadline,
        difficulty: task.difficulty,
        type: task.type,
        createdAt: task.createdAt || new Date().toISOString()
      });
    }
    res.json({ success: true });
  } catch (error: any) {
    console.error("Error saving tasks:", error);
    res.status(500).json({ error: error.message || "Failed to save tasks" });
  }
});

// Shared helper to compile prompt for Gemini and return schema config
function getGeminiConfig() {
  return {
    responseMimeType: "application/json",
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        timeBlocks: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING, description: "Title of the activity block" },
              startTime: { type: Type.STRING, description: "HH:MM format, 24-hour style" },
              endTime: { type: Type.STRING, description: "HH:MM format, 24-hour style" },
              date: { type: Type.STRING, description: "YYYY-MM-DD format of the scheduled day" },
              type: { 
                type: Type.STRING, 
                enum: ["Study", "Work", "Project", "Assignment", "Health", "Entertainment", "Break", "Buffer", "Productive Activity"],
                description: "The type of this activity block" 
              },
              description: { type: Type.STRING, description: "A highly context-aware brief instruction" },
              difficulty: { 
                type: Type.STRING, 
                enum: ["Easy", "Medium", "Hard", "None"],
                description: "Difficulty of the task if applicable, else 'None'"
              },
              isProductiveSuggestion: { 
                type: Type.BOOLEAN, 
                description: "True if the AI auto-scheduled a productive filler like Revision, Gym, Reading due to gaps in the day" 
              }
            },
            required: ["title", "startTime", "endTime", "date", "type", "description", "difficulty", "isProductiveSuggestion"]
          }
        },
        recommendations: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "High quality targeted recommendations for keeping the user on track"
        },
        explanation: {
          type: Type.STRING,
          description: "Clear detail explaining the logic: why deadlines prioritized, task importance, difficulty balancing, and alignment of entertainment toward evening."
        }
      },
      required: ["timeBlocks", "recommendations", "explanation"]
    }
  };
}

// Endpoint to generate schedule
app.post("/api/generate-schedule", async (req, res) => {
  const { userId, profile, tasks, currentDate } = req.body;
  if (!userId || !profile || !Array.isArray(tasks)) {
    return res.status(400).json({ error: "Missing required fields userId, profile, or tasks" });
  }

  const todayStr = currentDate || new Date().toLocaleDateString('sv-SE');

  try {
    const ai = getGeminiClient();

    // Prepare prompt
    const prompt = `
      You are the Lifeline AI Planner core scheduling engine.
      Your goal is to optimize a user's multi-day or single-day pipeline based on their tasks, deadlines, and profile.
      
      User Profile:
      - Role: ${profile.role}
      - Daily Available Free Hours: ${profile.dailyFreeHours}
      - Active Hours: Wake up at ${profile.wakeUpTime}, sleep at ${profile.sleepTime}.
      - Current Start Time (for today only): ${profile.currentStartTime || "Not specified"}
      
      Tasks list:
      ${JSON.stringify(tasks, null, 2)}
      
      ======================================================
      CRITICAL SAME-DAY & MULTI-DAY SCHEDULING RULES:
      Today's date is: ${todayStr}

      1. Detect and use the Current Start Time for today's schedule:
         - If 'Current Start Time' is specified (e.g., "${profile.currentStartTime || "Not specified"}"), you MUST ignore the standard wake-up time (${profile.wakeUpTime}) for TODAY's schedule blocks.
         - Today's scheduling window starts strictly at the 'Current Start Time' and ends at the Sleep cutoff time (${profile.sleepTime}).
         - If 'Current Start Time' is specified in 12-hour AM/PM format (e.g. "6:30 PM" or "6 PM"), parse/convert it to 24-hour style (e.g. "18:30" or "18:00") for the schedule blocks.
         - For example, if Current Start Time is 6:00 PM (18:00) and Sleep time is 10:00 PM (22:00), the available scheduling window for TODAY is 4 hours only (18:00 to 22:00).
         - NEVER schedule any time blocks for today before the 'Current Start Time' (e.g., if current start time is 18:00, do not create an 8:00 AM study block today). Past hours of the day are strictly unavailable.

      2. If a task's deadline is TODAY (${todayStr}):
         - Schedule work/prep for it TODAY starting strictly from the Current Start Time (if specified, otherwise wake up time) until the sleep cutoff time (${profile.sleepTime}).

      3. If a task's deadline is in the FUTURE (after ${todayStr}):
         - For future dates (e.g. ${todayStr} + 1 day, ${todayStr} + 2 days, etc.), use the standard wake up time (${profile.wakeUpTime}) and sleep cutoff time (${profile.sleepTime}) as the full daily availability window.
         - Distribute the preparation or work blocks gradually across the available days leading up to the deadline.
         - Do NOT assume the task is for today. Do NOT pack all of its study/prep blocks into today's schedule.
         - The AI must understand calendar dates. It should not schedule future tasks immediately as if the deadline is today.
         - Think like a long-term planner, not a same-day scheduler.
         
      For each scheduled block in the returned 'timeBlocks' array, you MUST output:
      - 'date': The exact date in 'YYYY-MM-DD' format (e.g., '${todayStr}', or future dates like '2026-06-28', '2026-06-29' etc.) when this block is scheduled.
      - 'startTime' and 'endTime' (HH:MM format, 24-hour style, strictly within the active window of that day:
         * For TODAY, strictly from the parsed Current Start Time (${profile.currentStartTime || profile.wakeUpTime}) to the sleep cutoff time (${profile.sleepTime}).
         * For FUTURE DAYS, strictly from the standard wake up time (${profile.wakeUpTime}) to the sleep cutoff time (${profile.sleepTime}).
      )
      - 'title': Descriptive title of the task prep or activity.
      - 'type': TaskType or other activity enum value.
      - 'description': Highly context-aware brief instruction.
      - 'difficulty': Energy level of the block.
      - 'isProductiveSuggestion': Boolean.
      ======================================================
      
      PRIORITY ORDER RULES:
      - Critical Productive Tasks always come first: Exam, Assignment, Project, Interview, Study, Office Work, Meeting.
      - Low Priority Tasks move toward the evening/night: Movie, Gaming, Social Media, Entertainment.
      - Important work must be scheduled before deadlines. If multiple important tasks exist, compare deadlines and do the ones with closer deadlines earlier.
      - If tasks are high difficulty ("Hard"), give them higher energy slots (usually morning/afternoon) and provide a buffer.
      
      BALANCED SCHEDULING RULES:
      - Never create extremely long, unrealistic rest periods. Do NOT schedule rest blocks longer than 60 minutes in the active day.
      - Breaks must be strictly between 10 and 60 minutes. Usually 15-30 mins after a hard task, 10 mins after an easy task.
      - If there are gaps on any scheduled day because the user has more "Daily Free Hours" than the total scheduled task durations for that day, do NOT leave large blank blocks. Instead, AUTO-SUGGEST highly productive activities from this list:
        * "Revision" (specifically review previous work or study material)
        * "Exercise" (workout, quick walk, stretching)
        * "Reading" (educative, career-advancing books or articles)
        * "Skill Learning" (coding practice, languages, writing)
        * "Planning Tomorrow" (organizing priorities)
        Mark these blocks with isProductiveSuggestion: true and type: "Productive Activity".
      - Never create unrealistic 5+ hour continuous work blocks. Break it down with breaks.
      - Ensure each scheduled day from wake up time to sleep time is fully accounted for with blocks.

      Format the entire output as a single JSON object matching the requested schema.
    `;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: getGeminiConfig()
    });

    const parsedSchedule = JSON.parse(response.text || "{}");

    // Save schedule to Firestore
    const scheduleId = "sched_" + Date.now();
    const scheduleData = {
      id: scheduleId,
      userId,
      tasks,
      timeBlocks: parsedSchedule.timeBlocks,
      recommendations: parsedSchedule.recommendations,
      explanation: parsedSchedule.explanation,
      feedback: "pending",
      createdAt: new Date().toISOString()
    };

    const scheduleDocRef = doc(db, "userProfiles", userId, "schedules", scheduleId);
    await setDoc(scheduleDocRef, scheduleData);

    res.json({ success: true, schedule: scheduleData });
  } catch (error: any) {
    console.error("Error generating schedule:", error);
    res.status(500).json({ error: error.message || "Failed to generate schedule" });
  }
});

// Endpoint to reschedule with user feedback
app.post("/api/reschedule", async (req, res) => {
  const { userId, profile, tasks, previousSchedule, feedbackText, currentDate } = req.body;
  if (!userId || !profile || !Array.isArray(tasks) || !previousSchedule) {
    return res.status(400).json({ error: "Missing required fields for rescheduling" });
  }

  const todayStr = currentDate || new Date().toLocaleDateString('sv-SE');

  try {
    const ai = getGeminiClient();

    const prompt = `
      You are the Lifeline AI Planner core scheduling engine.
      The user has requested to RESCHEDULE their pipeline because they are unhappy with the current schedule.
      
      User Profile:
      - Role: ${profile.role}
      - Daily Free Hours: ${profile.dailyFreeHours}
      - Wakeup: ${profile.wakeUpTime}, Sleep: ${profile.sleepTime}
      - Current Start Time (for today only): ${profile.currentStartTime || "Not specified"}

      User Tasks:
      ${JSON.stringify(tasks, null, 2)}

      Previous Schedule:
      ${JSON.stringify(previousSchedule, null, 2)}

      User's Feedback / Request for changes:
      "${feedbackText || "Make it more balanced, refine the breaks, or distribute the difficult tasks better."}"

      ======================================================
      CRITICAL SAME-DAY & MULTI-DAY SCHEDULING RULES:
      Today's date is: ${todayStr}

      1. Detect and use the Current Start Time for today's schedule:
         - If 'Current Start Time' is specified (e.g., "${profile.currentStartTime || "Not specified"}"), you MUST ignore the standard wake-up time (${profile.wakeUpTime}) for TODAY's schedule blocks.
         - Today's scheduling window starts strictly at the 'Current Start Time' and ends at the Sleep cutoff time (${profile.sleepTime}).
         - If 'Current Start Time' is specified in 12-hour AM/PM format (e.g. "6:30 PM" or "6 PM"), parse/convert it to 24-hour style (e.g. "18:30" or "18:00") for the schedule blocks.
         - For example, if Current Start Time is 6:00 PM (18:00) and Sleep time is 10:00 PM (22:00), the available scheduling window for TODAY is 4 hours only (18:00 to 22:00).
         - NEVER schedule any time blocks for today before the 'Current Start Time' (e.g., if current start time is 18:00, do not create an 8:00 AM study block today). Past hours of the day are strictly unavailable.

      2. If a task's deadline is TODAY (${todayStr}):
         - Schedule work/prep for it TODAY starting strictly from the Current Start Time (if specified, otherwise wake up time) until the sleep cutoff time (${profile.sleepTime}).

      3. If a task's deadline is in the FUTURE (after ${todayStr}):
         - For future dates (e.g. ${todayStr} + 1 day, ${todayStr} + 2 days, etc.), use the standard wake up time (${profile.wakeUpTime}) and sleep cutoff time (${profile.sleepTime}) as the full daily availability window.
         - Distribute the preparation or work blocks gradually across the available days leading up to the deadline.
         - Do NOT assume the task is for today. Do NOT pack all of its study/prep blocks into today's schedule.
         - The AI must understand calendar dates. It should not schedule future tasks immediately as if the deadline is today.
         - Think like a long-term planner, not a same-day scheduler.
         
      For each scheduled block in the returned 'timeBlocks' array, you MUST output:
      - 'date': The exact date in 'YYYY-MM-DD' format (e.g., '${todayStr}', or future dates like '2026-06-28', '2026-06-29' etc.) when this block is scheduled.
      - 'startTime' and 'endTime' (HH:MM format, 24-hour style, strictly within the active window of that day:
         * For TODAY, strictly from the parsed Current Start Time (${profile.currentStartTime || profile.wakeUpTime}) to the sleep cutoff time (${profile.sleepTime}).
         * For FUTURE DAYS, strictly from the standard wake up time (${profile.wakeUpTime}) to the sleep cutoff time (${profile.sleepTime}).
      )
      - 'title': Descriptive title of the task prep or activity.
      - 'type': TaskType or other activity enum value.
      - 'description': Highly context-aware brief instruction.
      - 'difficulty': Energy level of the block.
      - 'isProductiveSuggestion': Boolean.
      ======================================================

      Please generate a brand new, highly optimized schedule that directly addresses the user's feedback. 
      Ensure all previous PRIORITY ORDER and BALANCED SCHEDULING RULES are strictly obeyed.
      Specifically adjust the timing, durations, or types of blocks to accommodate the feedback.
      Explain clearly in the "explanation" section how you adjusted the schedule to resolve their feedback.
      
      Format the entire output as a single JSON object matching the requested schema.
    `;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: getGeminiConfig()
    });

    const parsedSchedule = JSON.parse(response.text || "{}");

    // Save schedule to Firestore
    const scheduleId = "sched_" + Date.now();
    const scheduleData = {
      id: scheduleId,
      userId,
      tasks,
      timeBlocks: parsedSchedule.timeBlocks,
      recommendations: parsedSchedule.recommendations,
      explanation: parsedSchedule.explanation,
      feedback: "pending", // Reset feedback state
      createdAt: new Date().toISOString()
    };

    const scheduleDocRef = doc(db, "userProfiles", userId, "schedules", scheduleId);
    await setDoc(scheduleDocRef, scheduleData);

    // Update old schedule to mark as "rescheduled"
    try {
      const oldDocRef = doc(db, "userProfiles", userId, "schedules", previousSchedule.id);
      await setDoc(oldDocRef, { ...previousSchedule, feedback: "rescheduled" });
    } catch (e) {
      console.error("Could not update previous schedule feedback:", e);
    }

    res.json({ success: true, schedule: scheduleData });
  } catch (error: any) {
    console.error("Error rescheduling:", error);
    res.status(500).json({ error: error.message || "Failed to reschedule" });
  }
});

// Endpoint to update feedback on a schedule (e.g. accepted "I Can Do It")
app.post("/api/save-feedback", async (req, res) => {
  const { userId, scheduleId, feedback } = req.body;
  if (!userId || !scheduleId || !feedback) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const docRef = doc(db, "userProfiles", userId, "schedules", scheduleId);
    const snap = await getDoc(docRef);
    if (!snap.exists()) {
      return res.status(404).json({ error: "Schedule not found" });
    }

    const updatedData = {
      ...snap.data(),
      feedback: feedback // "accepted" or "rescheduled"
    };

    await setDoc(docRef, updatedData);
    res.json({ success: true, schedule: updatedData });
  } catch (error: any) {
    console.error("Error saving feedback:", error);
    res.status(500).json({ error: error.message || "Failed to save feedback" });
  }
});

// Endpoint to update schedule blocks (e.g. checkbox completion)
app.post("/api/update-schedule-blocks", async (req, res) => {
  const { userId, scheduleId, timeBlocks } = req.body;
  if (!userId || !scheduleId || !Array.isArray(timeBlocks)) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const docRef = doc(db, "userProfiles", userId, "schedules", scheduleId);
    const snap = await getDoc(docRef);
    if (!snap.exists()) {
      return res.status(404).json({ error: "Schedule not found" });
    }

    const updatedData = {
      ...snap.data(),
      timeBlocks
    };

    await setDoc(docRef, updatedData);
    res.json({ success: true, schedule: updatedData });
  } catch (error: any) {
    console.error("Error updating schedule blocks:", error);
    res.status(500).json({ error: error.message || "Failed to update schedule blocks" });
  }
});

// Fetch coaching chat history
app.get("/api/get-coach-chat/:userId", async (req, res) => {
  const { userId } = req.params;
  if (!userId) {
    return res.status(400).json({ error: "userId is required" });
  }

  try {
    const colRef = collection(db, "userProfiles", userId, "coachMessages");
    const q = query(colRef, orderBy("timestamp", "asc"));
    const snap = await getDocs(q);
    const messages = snap.docs.map(doc => doc.data());
    res.json({ messages });
  } catch (error: any) {
    console.error("Error fetching coach chat:", error);
    res.status(500).json({ error: error.message || "Failed to fetch coach chat" });
  }
});

// Save coaching chat message
app.post("/api/save-coach-message", async (req, res) => {
  const { userId, role, text } = req.body;
  if (!userId || !role || !text) {
    return res.status(400).json({ error: "Missing required fields for saving coach message" });
  }

  try {
    const messageId = "msg_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6);
    const docRef = doc(db, "userProfiles", userId, "coachMessages", messageId);
    const messageData = {
      id: messageId,
      role,
      text,
      timestamp: new Date().toISOString()
    };
    await setDoc(docRef, messageData);
    res.json({ success: true, message: messageData });
  } catch (error: any) {
    console.error("Error saving coach message:", error);
    res.status(500).json({ error: error.message || "Failed to save coach message" });
  }
});

// Endpoint for AI Productivity Coach Chat
app.post("/api/coach-chat", async (req, res) => {
  const { userId, messages, profile, tasks, schedule } = req.body;
  if (!userId || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Missing required fields: userId or messages" });
  }

  try {
    const ai = getGeminiClient();

    // Resolve context
    let activeProfile = profile;
    let activeTasks = tasks;
    let activeSchedule = schedule;

    if (!activeProfile) {
      const profileSnap = await getDoc(doc(db, "userProfiles", userId));
      if (profileSnap.exists()) {
        activeProfile = profileSnap.data();
      }
    }
    if (!activeTasks) {
      const tasksSnap = await getDocs(collection(db, "userProfiles", userId, "tasks"));
      activeTasks = tasksSnap.docs.map(doc => doc.data());
    }
    if (!activeSchedule) {
      const schedulesSnap = await getDocs(collection(db, "userProfiles", userId, "schedules"));
      const sorted = schedulesSnap.docs
        .map(doc => doc.data())
        .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      activeSchedule = sorted[0] || null;
    }

    // Define Coaching System Instructions
    const systemInstruction = `
You are the "Lifeline AI Coach", a strict but helpful AI Productivity Coach and mentor. 
Your sole purpose is to help the user make better productivity decisions, avoid missing deadlines, and stay on track.

You MUST NOT behave like a normal, soft, generic assistant. You should be direct, highly focused, strict but supportive, and deeply serious about time management.

Your behavior rules:
1. Understand the user's current schedule, profile, and tasks:
   - User Profile: ${activeProfile ? JSON.stringify(activeProfile) : "Not configured yet"}
   - Current Tasks: ${activeTasks ? JSON.stringify(activeTasks) : "No tasks added yet"}
   - Active Schedule: ${activeSchedule ? JSON.stringify(activeSchedule) : "No schedule generated yet"}
2. Give concrete, strategic productivity advice. Use bullet points or short, sharp paragraphs. Keep responses concise, motivating, and actionable.
3. Answer questions related to task planning and prioritization.
4. If they complain they cannot follow the schedule, advise them to click the "Reschedule" button in the app and type specific requests, and offer strategic ideas on what to type (e.g., shorter work blocks, lighter day, more frequent breaks).
5. ALWAYS warn the user immediately if they propose prioritizing low-value activities (like watching movies, playing games, or long breaks) when high-priority tasks (Exams, Assignments, Projects) have near deadlines.
6. Act like a high-performance mentor. You call out excuses, but you also offer realistic recovery steps (e.g., "Take a 20-minute power nap or walk, then do 25 minutes of your highest-priority task. No excuses. Let's get to work.").

Examples of tone and behavior:
- User: "I feel tired and cannot study." -> "Take a 20 minute break, walk away from screens, then complete the highest priority task first. Let's start with just 15 minutes of focus. You have an assignment due soon; we can't afford procrastination. Let's go!"
- User: "Can I watch a movie now?" -> "Your assignment deadline is tomorrow! Watching a movie now is a low-value distraction. I recommend finishing your work first, then you can enjoy the movie guilt-free as a reward."
- User: "I cannot follow this schedule." -> "I understand. Let's lighten the load. Click the 'Reschedule' button above, and tell the AI: 'Make a lighter schedule with shorter 25-minute work sessions and 10-minute breaks.' That will help you build momentum without burning out."
`;

    // format messages array for Gemini
    const formattedContents = messages.map(msg => {
      const role = msg.role === "assistant" || msg.role === "model" ? "model" : "user";
      return {
        role,
        parts: [{ text: msg.text }]
      };
    });

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: formattedContents,
      config: {
        systemInstruction: systemInstruction
      }
    });

    const replyText = response.text || "I was unable to formulate a response. Let's keep focusing on your goals.";

    res.json({ reply: replyText });
  } catch (error: any) {
    console.error("Error in coach-chat:", error);
    res.status(500).json({ error: error.message || "Failed to process chat response" });
  }
});

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
