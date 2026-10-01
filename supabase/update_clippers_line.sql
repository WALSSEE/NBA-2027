-- Clippers: Pinnacle 28.5 (yli 1.952 / alle 1.869). Odotetut voitot samalla menetelmällä kuin muut (≈ 27.9).
update team_stats set win_total = 27.9, wt_line = 28.5, wt_over = 1.952, wt_under = 1.869 where team = 'Los Angeles Clippers';
select team, win_total, wt_line, wt_over, wt_under from team_stats where team = 'Los Angeles Clippers';
