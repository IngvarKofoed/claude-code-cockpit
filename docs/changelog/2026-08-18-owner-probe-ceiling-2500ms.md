# Owner probe ceiling raised to 2500ms

The owner probe's ceiling is 2500ms, up from 1200 (v0.41.0). `wmic` costs ~200ms on the machine
entry 107 measured but 1057–1243ms on a ~550-process Windows 11 box, so the old ceiling was a
coin flip there: 2 of 6 SessionStarts recorded a pid. The cost of a miss is bigger than entry
101's reaper, because entry 110 made focus-target resolution WAIT on the verified pid — so a
timed-out probe also means no `pid:` target, i.e. no Focus button, for the whole session.

<!-- entry 121 -->
