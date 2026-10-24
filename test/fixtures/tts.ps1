# Speak a sentence into a 16 kHz mono WAV with Windows' own voice, so the
# speech tests can hand the recognizer real speech without a microphone.
param([string]$Text, [string]$Out)
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile($Out, $fmt)
$synth.Rate = 0
$synth.Speak($Text)
$synth.Dispose()
