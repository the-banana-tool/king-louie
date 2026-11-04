# Task 11 report: the uninstaller removes the logon task

Files: build/installer.nsh (new), package.json (build.nsis.include), tests/installer-script.test.js (new).
RED: 6 of 6 failed before the script existed. GREEN: installer-script, examples and the tracked-file test pass (116 pass, 0 fail).

## Update trap
electron-builder's installer runs the old uninstaller during an update (installUtil.nsh passes `--updated`), and
uninstaller.nsh inserts customUnInstall at line 156 before its own `${if} ${isUpdated}` (line 164). The macro is
wrapped in `${ifNot} ${isUpdated}`; the test pins the guard and that the run sits inside it.
The `isUpdated` define itself is not in the template files (it comes from the builder's generated defines);
only its uses were read. An update keeps the install dir and `${APP_EXECUTABLE_FILENAME}` (`King Louie.exe`), so the task's pinned binary path keeps working.

## Decisions
- Binary via `$INSTDIR\${APP_EXECUTABLE_FILENAME}` (common.nsh line 16), not hard-coded. Asar path `resources\app.asar\bin\king-louie-service.js`.
- Env: ELECTRON_RUN_AS_NODE set via kernel32, cleared again (null value) right after the run.
- Exit code popped and ignored; macro never aborts. `--yes` means /S silent uninstall never prompts.
- Default install is per-user (no perMachine in package.json), so the uninstaller runs as the owner who owns the task. A per-machine/elevated uninstall: the CLI refuses elevated, the task stays and must be removed by hand; uninstall still completes.
- Order: CLI stops a running node first, then the installer removes files. Script deletes nothing; data dir untouched.

## Unverified
No installer built or run. The tests read the script: they show the rules are written, not that NSIS compiles it or that `isUpdated` resolves in the macro's scope.
