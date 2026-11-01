G21 G90 G94 G17
(XY positive and negative radius forms)
T4 M6
G0 X10 Y0 Z0
G3 X0 Y10 R10 F600
G2 X10 Y0 R-10
(ZX oriented plane - clockwise viewed from positive Y)
G18 G0 X10 Y20 Z0
G2 X0 Z10 I-10 K0
G3 X10 Z0 I0 K-10
(YZ helix and two turns)
G19 G0 X0 Y10 Z0
G3 X5 Y10 Z0 J-10 K0 P2 F600
(ZX drilling cycle)
G18 G0 X0 Y10 Z30
G98 G81 X10 Z20 Y-5 R2 F120
G80
(YZ drilling cycle)
G19 G0 X10 Y0 Z0
G99 G82 Y10 Z10 X-5 R2 P1 F120
G80
(Offsets length compensation and G92)
G17 G55 G43 H4
G0 X0 Y0 Z0
G92 X5 Z2
G1 X15 Z-2 F300
G49
G59.1 G0 X0 Y0 Z0
G59.2 X0
G59.3 Y0
G56 X0
G57 Y0
G58 Z0
G59 X0 Y0 Z0
(Machine moves and stored returns via intermediate points)
G91 G53 G0 Z-3
G90 G28 X5 Y-5
G91 G30 Z0
G90
S3000 M4
M7 M8
M1
M0
M9
M30
