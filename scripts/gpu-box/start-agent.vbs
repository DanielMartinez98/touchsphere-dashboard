' Starts the TouchSphere AI power agent (agent.js, beside this file) with no window.
' Launched at logon from the Startup folder ("TouchSphere AI agent" shortcut).
' The agent decides whether the AI comes up: it restores the last on/off state
' chosen from the dashboard (state.json).
Dim dir
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """C:\Program Files\nodejs\node.exe"" """ & dir & "\agent.js""", 0, False
