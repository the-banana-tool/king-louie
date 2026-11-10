# Boot node and tray: checks on the owner's machine

Spec `docs/superpowers/specs/2026-11-09-boot-node-tray-design.md`. No test covers the real
boot, UAC or S4U path; this list does. Use an installer built from the branch
(`npm run build:win`), installed over the app. Each item has its pass condition. Report a
failure with what the window, `king-louie-service doctor` and
`%LOCALAPPDATA%\KingLouie\node\data\logs\service.log` said.

1. **Install from the app.** Open King Louie, Settings > Local service > Install… (or the
   setup view). Pass: exactly one UAC prompt; the window shows the node installed.
   `schtasks /Query /TN "KingLouie Node" /XML` shows `LogonType` S4U, a boot trigger and a
   logon trigger, `RunLevel` LeastPrivilege, no `powershell`, and the security descriptor
   `D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;<your SID>)`. In `regedit`,
   `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` has `King Louie` =
   `"<app exe>" --kl-tray`. Declining the prompt changes nothing and the window says so.
2. **Reboot without logging in.** Restart, leave the lock screen alone. Pass: within a few
   minutes your phone confirms the node (no "Could not confirm").
3. **Log in.** Pass: King Louie appears in the tray with no window and no console window;
   `king-louie-service doctor` shows `screen host: connected` and a boot-task `hosting` row.
4. **Start and Restart, unelevated.** In Settings > Local service use Stop/Start and
   **Restart King Louie Node**. Pass: both work with no UAC prompt. If they do not, report
   it: the owner descriptor (D-1) is wrong.
5. **Lock during a take.** Start a take, lock the PC (Win+L). Pass: the take ends
   `screen_locked`; the node keeps running and the phone still confirms it.
6. **Sleep and wake.** Sleep the PC, wake it, log in. Pass: the node is still running, the
   tray app reconnects (`screen host: connected`), the phone confirms.
7. **A chat's browser tool after login.** In a chat ask for the browser on a saved profile.
   Pass: Chrome opens visibly on your desktop with your saved logins. Before login (or with
   the app quit from the tray) the same call refuses `screen_host_missing`.
8. **Shutdown with the app in the tray.** Log off, then shut down, with King Louie in the
   tray. Pass: no "King Louie is preventing shutdown" prompt.
9. **Quit during a take.** Quit from the tray while a take records. Pass: it asks "A take
   is recording. Quit and end it?"; No leaves it recording.
10. **Uninstall.** Settings > Local service > uninstall (or `uninstall --personal`). Pass: one
    UAC prompt; `schtasks /Query /TN "KingLouie Node"` finds nothing; the `King Louie` Run
    value is gone; the data dir is still there.
11. **Existing logon-task install (if you have one).** Before step 1, the window says "Install
    again to start at boot"; Install converts it, keeping `node.yaml`, the pairing and the
    phones.
12. **Stop.** `king-louie-service stop` after a boot start. Pass: the node process is gone (no
    leftover node.exe from the task's wrapper), and `schtasks /Run /TN "KingLouie Node"`
    brings it back.
