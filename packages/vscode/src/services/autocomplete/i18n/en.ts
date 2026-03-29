// English strings for autocomplete (NexusCode)

export const dict = {
  "nexuscode:autocomplete.statusBar.enabled": "$(sparkle) Autocomplete",
  "nexuscode:autocomplete.statusBar.snoozed": "snoozed",
  "nexuscode:autocomplete.statusBar.warning": "$(warning) Autocomplete",
  "nexuscode:autocomplete.statusBar.tooltip.basic": "NexusCode inline completion",
  "nexuscode:autocomplete.statusBar.tooltip.disabled": "NexusCode inline completion (disabled)",
  "nexuscode:autocomplete.statusBar.tooltip.noUsableProvider":
    "**No model configured**\n\nConfigure the agent model in `.nexus/nexus.yaml` or VS Code **NexusCode** settings, then reload if needed.\n\n[Open settings]({{command}})",
  "nexuscode:autocomplete.statusBar.tooltip.sessionTotal": "Session total (cost field reserved):",
  "nexuscode:autocomplete.statusBar.tooltip.provider": "Provider:",
  "nexuscode:autocomplete.statusBar.tooltip.model": "Model:",
  "nexuscode:autocomplete.statusBar.tooltip.profile": "Profile: ",
  "nexuscode:autocomplete.statusBar.tooltip.defaultProfile": "Default",
  "nexuscode:autocomplete.statusBar.tooltip.completionSummary":
    "Performed {{count}} completions between {{startTime}} and {{endTime}}.",
  "nexuscode:autocomplete.statusBar.tooltip.providerInfo": "Completions use {{model}} ({{provider}}).",
  "nexuscode:autocomplete.statusBar.cost.zero": "$0.00",
  "nexuscode:autocomplete.statusBar.cost.lessThanCent": "<$0.01",
  "nexuscode:autocomplete.toggleMessage": "NexusCode Autocomplete {{status}}",
  "nexuscode:autocomplete.progress.title": "NexusCode",
  "nexuscode:autocomplete.progress.analyzing": "Analyzing your code...",
  "nexuscode:autocomplete.progress.generating": "Generating suggested edits...",
  "nexuscode:autocomplete.progress.processing": "Processing suggested edits...",
  "nexuscode:autocomplete.progress.showing": "Displaying suggested edits...",
  "nexuscode:autocomplete.input.title": "NexusCode: Quick task",
  "nexuscode:autocomplete.input.placeholder": "e.g. 'refactor this function'",
  "nexuscode:autocomplete.commands.generateSuggestions": "NexusCode: Generate inline completion",
  "nexuscode:autocomplete.commands.displaySuggestions": "Display suggested edits",
  "nexuscode:autocomplete.commands.cancelSuggestions": "Cancel suggested edits",
  "nexuscode:autocomplete.commands.applyCurrentSuggestion": "Apply current suggestion",
  "nexuscode:autocomplete.commands.applyAllSuggestions": "Apply all suggestions",
  "nexuscode:autocomplete.commands.category": "NexusCode",
  "nexuscode:autocomplete.codeAction.title": "NexusCode: Suggested completion",
  "nexuscode:autocomplete.chatParticipant.fullName": "NexusCode",
  "nexuscode:autocomplete.chatParticipant.name": "Agent",
  "nexuscode:autocomplete.chatParticipant.description": "Inline completion and agent tasks.",
  "nexuscode:autocomplete.incompatibilityExtensionPopup.message":
    "NexusCode inline completion may conflict with GitHub Copilot inline suggestions. Disable one of them.",
  "nexuscode:autocomplete.incompatibilityExtensionPopup.disableCopilot": "Disable Copilot completions",
  "nexuscode:autocomplete.incompatibilityExtensionPopup.disableInlineAssist": "Disable NexusCode autocomplete",
  "nexuscode:autocomplete.creditsExhausted.message":
    "Inline completion paused: provider returned quota or billing error (HTTP 402). Check your API account.",
  "nexuscode:autocomplete.creditsExhausted.openSettings": "Open settings",
  "nexuscode:autocomplete.authError.message":
    "Inline completion paused: authentication failed. Check API keys and provider settings.",
}
