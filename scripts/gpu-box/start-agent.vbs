' Runs the TouchSphere AI power agent (agent.js, beside this file) with no
' window, and starts it again whenever it stops. Launched at logon from the
' Startup folder ("TouchSphere AI agent" shortcut).
'
' The agent restores the last on/off state chosen from the dashboard
' (state.json) each time it starts. It exits at once when another copy already
' holds its port, so a second launcher is harmless: it just checks back in a
' minute. Every exit is written to supervisor.log with its code, because the
' agent once vanished and left no trace of why.
Option Explicit
Dim fso, sh, dir, cmd, code, started, wait, logFile
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = """C:\Program Files\nodejs\node.exe"" """ & dir & "\agent.js"""

Sub Note(text)
  On Error Resume Next
  Set logFile = fso.OpenTextFile(dir & "\supervisor.log", 8, True)
  logFile.WriteLine Now & "  " & text
  logFile.Close
End Sub

Do
  started = Timer
  code = sh.Run(cmd, 0, True)
  If code = 0 And Abs(Timer - started) < 5 Then
    ' Another copy already has the port (or it could not start at all).
    wait = 60000
  Else
    Note "agent exited with code " & code & " after " & Round(Abs(Timer - started)) & " s; starting it again in 10 s"
    wait = 10000
  End If
  WScript.Sleep wait
Loop
