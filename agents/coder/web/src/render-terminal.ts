// Moved to @proagentstore/sdk/ui so the console and any agent UI colorize identically —
// the console previously rendered terminal tails as an uncolorized <pre> (#187). Re-exported
// here so existing importers in this package keep working unchanged.
export { renderTerminal } from "@proagentstore/sdk/ui";
