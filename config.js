// ═══════════════════════════════════════════════
//  MAGI APP CONFIGURATION — ~/magi-app/config.js
//  Add/edit personas here.
//  Prompts live in ~/magi-app/prompts/*.md
// ═══════════════════════════════════════════════
const CONFIG = {
  API_URL: "http://localhost:3131",
  // Total GPU VRAM in GB — used only to render the header usage bar/percentage.
  TOTAL_VRAM_GB: 8,
};

const PERSONAS = [
  {
    id: "magi-core",
    name: "MAGI-CORE",
    subtitle: "General Assistant",
    color: "#6b4a2a",
    model: "qwen3:8b",
    supportsThink: true,
    options: { temperature: 0.7, num_ctx: 8192 },
  },
  {
    id: "magi-code",
    name: "MAGI-CODE",
    subtitle: "Coding Assistant",
    color: "#8a5a00",
    model: "qwen2.5-coder:7b",
    supportsThink: false,
    options: { temperature: 0.0, num_ctx: 32768 },
  },
  {
    id: "magi-sensei",
    name: "MAGI-SENSEI",
    subtitle: "Personal Tutor",
    color: "#1f6b4a",
    model: "qwen3:8b",
    supportsThink: true,
    options: { temperature: 0.4, num_ctx: 16384 },
  },
  {
    id: "magi-hacker",
    name: "MAGI-HACKER",
    subtitle: "Offensive Security",
    color: "#b0141f",
    model: "WhiteRabbitNeo/WhiteRabbitNeo-2.5-Qwen-2.5-Coder-7B:latest",
    supportsThink: false,
    options: { temperature: 0.2, num_ctx: 16384 },
  },
  {
    id: "magi-unlocked",
    name: "MAGI-UNLOCKED",
    subtitle: "No Filter",
    color: "#4a1f6b",
    model: "dolphin3:8b",
    supportsThink: false,
    options: { temperature: 0.7, num_ctx: 16384 },
  },
];
