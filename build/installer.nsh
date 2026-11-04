; Included by electron-builder (package.json build.nsis.include).
;
; Spec 2026-11-03-attach-stage2-design.md section 6.8. The desktop window can
; install a personal node, which registers the logon task "KingLouie Node"
; pointing at this app's binary. Uninstalling the app must take the task
; away, or it would try to start a binary that is gone at every logon.
;
; electron-builder also runs the OLD version's uninstaller (and so this macro)
; during an app update. The ${isUpdated} guard keeps an update from removing
; the owner's task: an update keeps the install dir and ${APP_EXECUTABLE_FILENAME},
; so the task's pinned path still works afterwards.
;
; Order: the CLI stops a running node first, so a node running as this app's
; binary does not hold files that the uninstall then removes. The CLI deletes
; the task itself; this script deletes nothing, and never touches the data dir.
;
; A failure must not stop the uninstall: the exit code is popped and ignored.
; The install is per-user by default, so the uninstaller runs as the owner and
; owns the task. An elevated (per-machine) uninstall makes the CLI refuse, and
; the task is then left behind for the owner to remove by hand.
; The CLI runs with --yes, so a silent (/S) uninstall never waits for a prompt.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
    nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\app.asar\bin\king-louie-service.js" uninstall --personal --yes'
    Pop $R9
    ; do not leak the variable to anything the uninstaller starts afterwards
    System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", n)'
  ${endIf}
!macroend
