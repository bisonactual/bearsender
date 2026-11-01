N10 G20 G90 G17 G94
(Inch rectangle and incremental full circle)
T3 M6
N20 G0 X0 Y0 Z0.25
N30 G1 Z-0.05 F10
N40 G91 X1
N50 Y0.5
N60 X-1
N70 Y-0.5
N80 G2 I0.25 J0 F20
G90 G0 Z0.25
(Absolute arc centre in inches)
G0 X1 Y0
G90.1 G3 X1.5 Y0.5 I1 J0.5 F20
G91.1
(Inverse time feed - exactly 30 seconds each)
G21 G91 G93 G1 X10 F2
Y10 F2
G94 G90
M2
