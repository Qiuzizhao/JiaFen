$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$speaker = [System.Speech.Synthesis.SpeechSynthesizer]::new()
$chineseVoice = $speaker.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -match '^zh' } | Select-Object -First 1
if ($chineseVoice) { $speaker.SelectVoice($chineseVoice.VoiceInfo.Name) }
$speaker.Rate = 1
[Console]::WriteLine('ready')
while ($null -ne ($voiceLine = [Console]::ReadLine())) {
    try {
        $voiceMessage = $voiceLine | ConvertFrom-Json
        $speaker.Speak([string]$voiceMessage.text)
        [Console]::WriteLine('done')
    } catch { [Console]::WriteLine('failed') }
}
$speaker.Dispose()
