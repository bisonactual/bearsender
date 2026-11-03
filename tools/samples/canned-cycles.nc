%
G21 G90 G17 G94
(Drilling grid - G81 G98 initial level)
T1 M6
S4000 M3 M8
G0 X0 Y0 Z10
G98 G81 X10 Y10 Z-8 R2 F240 L2
X20
G80
(Dwell counterbores - G82 G99)
G99 G82 X30 Y10 Z-4 R2 P0.5 F180
X40
G80
(Peck drilling - G83)
G98 G83 X10 Y25 Z-10 R2 Q4 F200
G80
(Chip breaking - G73)
G99 G73 X20 Y25 Z-10 R2 Q3 F200
G80
(Feed out boring - G85)
T2 M6
G85 X30 Y25 Z-6 R2 F120
G80
(Dwell and feed out - G89)
G89 X40 Y25 Z-6 R2 P0.75 F120
G80
(Incremental repeated holes - sticky R and depth)
G0 Z10
G91 G99 G81 X5 Y5 Z-6 R-8 L3 F240
X5 L2
L2
G80
G90 G0 Z10
M9 M5
M30
%
