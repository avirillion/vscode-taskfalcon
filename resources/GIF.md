Screencast
==========
1. Record video with QuickTime
2. Create color palette from video  
   `ffmpeg -y -i in.mov -vf fps=10,palettegen palette.png`
3. Convert video to gif
   `ffmpeg -i in.mov -i palette.png -filter_complex "fps=10,paletteuse" out.gif`
