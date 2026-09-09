# Classic console windows now actually focus

A CLASSIC console window now actually focuses (v0.41.0) — cmd.exe/powershell.exe under conhost,
i.e. any machine whose default terminal is the Console Host rather than WT. Resolution already
worked: the console window belongs to the console CLIENT, a plain ancestor reporting a real
MainWindowHandle, while only its conhost.exe child reports 0. The RAISE was broken — a detached
daemon has no foreground rights. Entry 102 was right about the walk, wrong about the raise.

<!-- entry 122 -->
