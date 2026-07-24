import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("phase7-tools", {
		description: "Set the active Pi tool list for MCP reconciliation tests",
		handler: async (args, ctx) => {
			const tools = args.trim() === "none" ? [] : args.split(",").map((tool) => tool.trim()).filter(Boolean);
			pi.setActiveTools(tools);
			ctx.ui.notify(`Active tools: ${tools.join(", ") || "none"}`);
		},
	});
}
