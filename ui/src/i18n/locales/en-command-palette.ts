import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Chat discovery copy loads with transcript search, the composer, and the
// shortcuts dialog rather than the shell.
const enCommandPalette = {
  // Empty anchors keep the canonical catalog composition stable; the feature
  // copy that used to live here is gone.
  commandPalette: {},
  palette: {},
  sessionsView: {
    transcriptSearchTitle: "Search transcripts",
    transcriptSearchDescription:
      "Find exact words or phrases in user and assistant messages across the default agent's sessions.",
    transcriptSearchInputLabel: "Search session transcripts",
    transcriptSearchPlaceholder: "Search exact words or phrases…",
    transcriptSearchAction: "Search",
    transcriptSearchClear: "Clear",
    transcriptSearchRetry: "Retry",
    transcriptSearchSearching: "Searching transcripts…",
    transcriptSearchUnavailable: "Transcript search requires a newer Gateway.",
    transcriptSearchError: "Transcript search failed",
    transcriptSearchIndexing:
      "The transcript index is still updating. Retry to include recent messages.",
    transcriptSearchArchivedExcluded:
      "{count} archived transcripts excluded; open a session to restore its searchable history.",
    transcriptSearchEmpty: "No transcript messages match that search.",
    transcriptSearchMatches: "Transcript matches: {count}",
    transcriptSearchTruncated: "Showing the first 25 matches.",
  },

  shortcutsOverlay: {
    title: en.shortcutsOverlay.title,
    sections: {
      general: "General",
      chat: "Chat",
      panels: "Panels",
      sidebar: "Sidebar",
      imageViewer: "Image viewer",
      approvals: "Approvals",
    },
    labels: {
      newSession: "Open New Session",
      archiveSession: "Archive current session",
      keyboardShortcuts: "Show keyboard shortcuts",
      toggleSidebar: "Toggle sidebar",
      debugOverlay: "Toggle debug overlay",
      appearanceSettings: "Open appearance settings",
      startNewSession: "Start new session (from the new-session page)",
      closeDialog: "Close dialog or exit settings",
      sendMessage: "Send message",
      newline: "Insert new line",
      steerImmediately: "Steer active response",
      historyRecall: "Browse sent message history",
      transcriptSearch: "Search conversation",
      clearReply: "Clear reply",
      stopResponse: "Stop active response",
      cancelDictation: "Cancel dictation",
      saveQueuedMessage: "Save queued message",
      toggleSessionSelect: "Select multiple sessions",
      extendSessionSelect: "Extend session selection",
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      zoomReset: "Reset zoom",
      panImageHorizontal: "Pan image horizontally",
      panImageVertical: "Pan image vertically",
      terminalPanel: "Toggle terminal panel",
      workspaceFiles: "Toggle workspace files",
      sideChat: "Toggle side chat",
      browserPanel: "Toggle browser panel",
      desktopPanel: "Toggle desktop panel",
      discussionPanel: "Toggle discussion panel",
      dashboardPanel: "Toggle dashboard panel",
      reviewPanel: "Toggle review panel",
      approveOnce: "Approve once",
      approveAlways: "Always allow",
      denyApproval: "Deny approval",
    },
  },
  chat: {
    welcome: {
      hintBeforeShortcut: "Type a message below ·",
      hintAfterShortcut: "for commands",
      recentSessions: "Recent chats",
      suggestions: {
        whatCanYouDo: en.chat.welcome.suggestions.whatCanYouDo,
        summarizeRecentSessions: "Summarize my recent sessions",
        configureChannel: "Help me configure a channel",
        checkSystemHealth: "Check system health",
      },
    },
    commands: {
      arguments: "Command arguments",
      menu: "Slash commands",
      optionCount: "{count} options",
      clearDescription: "Clear chat history",
      redirectDescription: "Abort and restart with a new message",
      steerDescription: "Inject a message into the active run",
      exportDescription: "Download this conversation as Markdown",
      categories: {
        session: "Session",
        model: "Model",
        agents: "Agents",
        tools: "Tools",
      },
    },
  },
} satisfies TranslationMap;

export const registerCommandPaletteEnglish = Object.assign(
  () => {
    Object.assign(en.shortcutsOverlay, enCommandPalette.shortcutsOverlay);
    Object.assign(en.chat.welcome, enCommandPalette.chat.welcome);
    Object.assign(en.chat.commands, enCommandPalette.chat.commands);
    Object.assign(en.sessionsView, enCommandPalette.sessionsView);
  },
  { catalog: enCommandPalette },
);
