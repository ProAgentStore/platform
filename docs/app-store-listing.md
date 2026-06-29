# PAGS — App Store Listing

## App Name
ProAgentStore

## Display Name
PAGS

## Subtitle (30 chars)
Native AI agent console

## Category
Productivity

## Secondary Category
Developer Tools

## Price
Free

## Bundle ID
`online.proagentstore.app`

## SKU
`pags-ios`

## Description (4000 chars max)
ProAgentStore is a native control center for server-powered AI agents.

Run your private agents from your phone, review their work, approve tasks, and keep project context moving without opening a web console.

**Chat with agent instances**

Open any private instance and continue a native chat thread with the agent. Messages, tool output, and responses are rendered in the app with no embedded web views.

**Review work on a board**

See active, waiting, completed, and failed runtime tasks in a native kanban board. Open a task to inspect its events, provide required input, approve work, resume execution, or cancel active work.

**Manage coding sessions**

Connect coding repositories, start a cloud coding session, send instructions, and watch terminal output or activity timeline from a focused mobile interface.

**Customize agent behavior**

Edit special instructions and profile context used by your PAGS instances. Keep each agent aligned with your preferred tone, rules, and operating constraints.

**Built for private agent operations**

PAGS uses your ProAgentStore account and the ProAgentStore API. Session tokens are stored in the iOS Keychain. The app does not use ads, tracking, camera, microphone, contacts, or location permissions.

## Promotional Text (170 chars)
Run private ProAgentStore agents, chat with instances, review kanban tasks, and manage coding sessions from a native iOS app.

## Keywords (100 chars)
AI agents,automation,kanban,coding,chat,workflow,approvals,productivity,developer

## What's New (4000 chars)
First public release of the native ProAgentStore app for iOS.

## Privacy Policy URL
https://proagentstore.online/app/privacy/

## Terms of Service URL
https://proagentstore.online/app/terms/

## Support URL
https://proagentstore.online/app/support/

## Marketing URL
https://proagentstore.online/

## Screenshots Needed (iOS)
1. Instances and native chat with a private agent.
2. Kanban board with active, waiting, completed, and failed tasks.
3. Task detail with approve, resume, input, and cancel actions.
4. Coding session with terminal output and timeline.
5. Settings with special instructions and privacy positioning.

## App Review Notes (iOS)
- This is a native SwiftUI app. It is not a web wrapper and does not embed `WKWebView` or `SFSafariViewController`.
- A ProAgentStore account is required. Review credentials should be added in App Store Connect under App Review Information.
- Sign in with the "Continue with ProAgentStore" button. The app uses `ASWebAuthenticationSession` only for OAuth, then returns to the native app through the `pags://auth` callback.
- To test: sign in, open an agent instance, send a chat message, open Board to inspect tasks, then open Coder to view or start a coding session.
- The app uses the network to communicate with `https://api.proagentstore.online`.
- The app does not request camera, microphone, contacts, location, or push notification permissions.
- Session tokens are stored in the iOS Keychain.

## App Privacy Answers
- Tracking: No.
- Ads: No.
- Third-party analytics: No.
- Data linked to the user: account identifier, agent messages, runtime task data, coding session data, and profile/special-instruction content used for app functionality.
- Data not linked to the user: none intentionally collected by the app.
- Sensitive data: not intentionally collected; users should not enter secrets into agent chat unless they intend the agent/runtime to use them.
- Location, contacts, photos, camera, microphone, health, fitness, financial information: not collected by the iOS app.

## Current Submission Blockers
- Create the App Store Connect app record for bundle id `online.proagentstore.app`.
- Set `APP_STORE_APP_ID` in Codemagic after the app record exists.
- Provide App Review test credentials for a seeded PAGS account with at least one instance, one board task, and one coding repository/session.
- Generate final App Store PNG screenshots from `platform/assets/store`.
