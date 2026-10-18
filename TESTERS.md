# Testing Juno

Thanks for helping test. Juno lets you draw a box (or any shape) around something on your screen, like a math problem, a chart or a paragraph in a PDF, and ask Claude or ChatGPT about exactly that.

This is an early test build, without accounts. Your computer will warn you once when you open it, because the app isn't signed by Apple or Microsoft yet.

## Download

From **Assets** at the bottom of the release page, download the one for your computer:

| Your computer | File |
| --- | --- |
| Mac with macOS 14 (Sonoma) or later, Apple Silicon or Intel | `Juno-…-mac.dmg` |
| Windows 10 or 11, 64-bit | `Juno-…-windows-setup.exe` |

## Check your download (optional)

The release lists `SHA256SUMS`, the fingerprint of each file. On a Mac, `shasum -a 256 Juno-*-mac.dmg` in Terminal should print the same line; on Windows, `Get-FileHash .\Juno-*-setup.exe` in PowerShell. With the GitHub CLI, `gh attestation verify <file> --repo jeffreylan0/selectionai` also proves it was built by this repository's own workflow.

## Install on a Mac

1. Open the `.dmg` and drag **Juno** into **Applications**.
2. Open it from Applications. macOS says it "could not verify Juno is free of malware". Click **Done**, not Move to Trash.
3. Open **System Settings → Privacy & Security**, scroll down to *"Juno" was blocked*, click **Open Anyway** and enter your password. This is needed once per build.
   (If you use Terminal, `xattr -dr com.apple.quarantine "/Applications/Juno.app"` does the same thing.)
4. The app lives in the menu bar, with no Dock icon, and its bar opens at the bottom of the screen. The first time, it asks for **Screen Recording**:
   - Click *Turn on Screen Recording*.
   - Switch **Juno** on under *Screen & System Audio Recording*.
   - Click **Restart** on the bar.

   This is the only permission the app asks for. It records no video and no audio: it takes one picture of the area you select, when you select it.

## Install on Windows

1. Run the `-setup.exe`. If Windows says *Windows protected your PC*, click **More info → Run anyway**.
2. It installs for your account only, so no administrator password is needed. Leave *Run Juno* ticked at the end. The bar comes up at the bottom of the screen, and Juno's blue icon is in the system tray; click **^** next to the clock if it's hidden.

Windows asks for no permissions.

## Choose who answers

Open settings with the gear on the bar, or right-click the menu bar or tray icon and choose **Settings…**. Under **Answers**, pick one:

- **Claude** or **ChatGPT**: paste an API key. Get one at [console.anthropic.com](https://console.anthropic.com/settings/keys) or [platform.openai.com](https://platform.openai.com/api-keys). API use is pay-as-you-go and is billed separately from a Claude or ChatGPT subscription. If you were given a key for testing, paste that.
- **Local model**: a model running on your own computer, such as one served by Ollama. It must be a model that reads images. (In the app, a server on another computer needs an `https://` address or a `.local` name.)
- **Placeholder**: made-up answers, no AI. Use it to try the selecting without a key.

Your key stays on your computer, in a file only your user account can read. It is only ever sent to the company that issued it. When you ask, only your selection and your question go to the AI you chose. The app collects no analytics.

## Use it

1. Press **Option+Shift+S** on a Mac or **Alt+Shift+S** on Windows, or click the menu bar or tray icon. The screen dims a little and the bar comes up.
2. **Box**: drag a rectangle. **Freeform**: draw around anything, in any shape.
3. A panel opens at the top right with your selection. Press **Explain**, **Hint**, **Check** or **Answer** (the answer first, then the explanation), or type your own question.

**Esc** cancels. You can still scroll the page underneath while the bar is waiting.

In the panel:

- Your questions show in rounded bubbles. Point at one to **copy** it; the latest one can also be **edited** (ask it again, reworded) or **retried** (asked again as it was). Answers have a copy button too.
- **⌘⇧O** on a Mac or **Ctrl+Shift+O** on Windows starts a new chat: the current one is finished (and kept in the chat menu), and the bar comes up for the next selection.
- Scroll up while an answer is coming in and the panel stays where you are; scroll back to the bottom and it follows the answer again.
- Resize the panel by its edges and it keeps that size from then on. Settings → **Selecting** shows the saved size, with a link to let it grow with the chat again.

Settings → **Selecting** → *Where the bar and the panel go* picks a part of the screen for each: click one of the nine squares. The bar sits at that part's outer edge (the bottom of the screen to start), and the panel in its corner or side (top right to start).

Settings → **Appearance** has seven colour themes. Each follows your computer's light or dark mode.

## What to look for

- **Installing:** where did you hesitate or get stuck?
- **Different apps:** select over PDFs, slides, videos and video calls, websites, full-screen apps and a second monitor.
- **Answers:** are they to the point? Does math display properly?
- **Speed:** how long from letting go to the panel opening, and to the first words of the answer?
- **Anything else:** anything that flickers, looks off, feels slow or is confusing in settings.

## Report a problem

Email info@humanbn.com, or open an issue at [github.com/jeffreylan0/selectionai/issues](https://github.com/jeffreylan0/selectionai/issues). Include:

- **Your computer:** Mac or Windows, and its version. On a Mac, use Apple menu → About This Mac. On Windows, use Settings → System → About.
- **What happened:** what you did, what you expected, and what happened instead.
- **A picture:** a screenshot or screen recording if you can. Use Shift-Command-5 on a Mac, or Windows+Shift+S on Windows.

Keep your API key out of screenshots.

If the app doesn't start or shows nothing, also attach its log, which holds only the app's own steps and errors: on a Mac `~/Library/Logs/Juno/juno.log` (in Finder: Go → Go to Folder…), on Windows `%LOCALAPPDATA%\com.humanbn.juno\juno.log` (paste that into the File Explorer address bar).

## Update or uninstall

- **Coming from Selection AI:** earlier test builds were called Selection AI. Before you open Juno for the first time:
  1. In Selection AI, turn *Open at login* off if you turned it on, then quit it.
  2. Open Juno: it takes over Selection AI's settings, key and chats.
  3. Then remove Selection AI (Mac: drag it to the Trash; Windows: Settings → Apps → Selection AI → Uninstall).

  On a Mac, allow Screen Recording for Juno; the old *Selection AI* entry in that list can be removed with **−**.
- **Updating:** once a build with updates is out, Juno updates itself: it downloads the new version in the background and installs it when you're not using it, then restarts in the menu bar. Settings → **Juno** shows the version, and lets you turn this off or check now. Until then (and to update by hand), install the new build over the old one; on a Mac, quit first (right-click the menu bar icon → Quit), then replace the app in Applications.
- **Screen Recording after a Mac update:** each new build is a new app to macOS, so allow Screen Recording again. If the switch already shows as on but the app can't see the screen:
  1. Select Juno in that list.
  2. Remove it with **−**.
  3. Open the app and turn it on again.
- **Uninstalling on a Mac:** quit the app and drag it to the Trash. To also remove your settings, key and chats, delete `~/Library/Application Support/com.humanbn.juno`.
- **Uninstalling on Windows:** go to Settings → Apps → Installed apps → Juno → Uninstall.
