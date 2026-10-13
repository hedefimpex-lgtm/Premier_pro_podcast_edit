; Podcast Kurgu Asistanı — Windows kurulum programı (Inno Setup 6.1+)
; Derleme: "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\PodcastKurgu.iss
; Çıktı:   installer\Output\PodcastKurgu-Setup-<sürüm>.exe

#define AppName "Podcast Kurgu Asistanı"
#define AppVersion "1.0.0"
#define AppPublisher "Podcast Kurgu"
#define ExtId "com.podcastkurgu.panel"
#define WhisperVersion "v1.7.6"

#define FfmpegUrl1 "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
#define FfmpegUrl2 "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
#define WhisperUrl1 "https://github.com/ggml-org/whisper.cpp/releases/download/" + WhisperVersion + "/whisper-bin-x64.zip"
#define WhisperUrl2 "https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip"
#define ModelBase "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/"

[Setup]
AppId={{8C1B6C55-6A0E-4C2B-9E2E-3F1A7B5D9C42}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={userappdata}\Adobe\CEP\extensions\{#ExtId}
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=Output
OutputBaseFilename=PodcastKurgu-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ShowLanguageDialog=no
CloseApplications=no
UninstallDisplayName={#AppName}
VersionInfoVersion={#AppVersion}
VersionInfoDescription={#AppName} kurulum programı

[Languages]
Name: "turkish"; MessagesFile: "compiler:Languages\Turkish.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
turkish.FinishedLabel=Kurulum tamamlandı.%n%nPremiere Pro açıksa yeniden başlatın ve paneli şuradan açın:%nPencere > Uzantılar > Podcast Kurgu Asistani%n%nEksik bileşenleri panelin "Ayarlar" sekmesinden indirebilirsiniz.
english.FinishedLabel=Setup has finished.%n%nRestart Premiere Pro if it is running and open the panel from:%nWindow > Extensions > Podcast Kurgu Asistani

[Tasks]
Name: "ffmpeg"; Description: "FFmpeg (ses çözme, zorunlu, ~100-200 MB)"; GroupDescription: "İndirilecek bileşenler:"
Name: "whisper"; Description: "Whisper yapay zeka motoru (altyazı ve takılma tespiti, ~5 MB)"; GroupDescription: "İndirilecek bileşenler:"
Name: "model"; Description: "Konuşma tanıma modeli"; GroupDescription: "Yapay zeka modeli:"
Name: "model\small"; Description: "Small - önerilen denge (466 MB)"; Flags: exclusive
Name: "model\turbo"; Description: "Large v3 Turbo Q5 - en iyi Türkçe doğruluğu (547 MB)"; Flags: exclusive unchecked
Name: "model\base"; Description: "Base - en hızlı, düşük doğruluk (142 MB)"; Flags: exclusive unchecked

[Files]
Source: "..\extension\*"; DestDir: "{app}"; Excludes: ".debug"; Flags: recursesubdirs createallsubdirs ignoreversion

[Registry]
; İmzasız CEP uzantılarının yüklenmesine izin ver (Premiere Pro 2019 - 2026)
Root: HKCU; Subkey: "Software\Adobe\CSXS.9"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.10"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.11"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.12"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.13"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"

[Code]
var
  DownloadPage: TDownloadWizardPage;
  GotFfmpeg, GotWhisper, GotModel: Boolean;
  ModelFile: String;

function IsAsciiPath(S: String): Boolean;
var
  I: Integer;
begin
  Result := True;
  for I := 1 to Length(S) do
    if (Ord(S[I]) < 32) or (Ord(S[I]) > 126) then
    begin
      Result := False;
      Exit;
    end;
end;

{ Panel ile aynı kural (paths.js): kullanıcı klasörü Türkçe karakter içeriyorsa C:\Users\Public kullanılır }
function ToolsRoot(): String;
begin
  Result := ExpandConstant('{localappdata}') + '\PodcastKurgu';
  if IsAsciiPath(Result) then Exit;
  Result := GetEnv('PUBLIC') + '\PodcastKurgu';
  if (GetEnv('PUBLIC') <> '') and IsAsciiPath(Result) then Exit;
  Result := 'C:\PodcastKurgu';
end;

function OnDownloadProgress(const Url, FileName: String; const Progress, ProgressMax: Int64): Boolean;
begin
  Result := True;
end;

procedure InitializeWizard;
begin
  DownloadPage := CreateDownloadPage(SetupMessage(msgWizardPreparing), SetupMessage(msgPreparingDesc), @OnDownloadProgress);
end;

function TryDownload(Urls: TArrayOfString; FileName: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 0 to GetArrayLength(Urls) - 1 do
  begin
    DownloadPage.Clear;
    DownloadPage.Add(Urls[I], FileName, '');
    try
      DownloadPage.Download;
      Result := True;
      Exit;
    except
      Log('Indirme basarisiz: ' + Urls[I] + ' - ' + GetExceptionMessage);
      if DownloadPage.AbortedByUser then Exit;
    end;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  U: TArrayOfString;
  Failed: String;
begin
  Result := True;
  if CurPageID <> wpReady then Exit;
  Failed := '';
  ModelFile := '';
  if WizardIsTaskSelected('model\small') then ModelFile := 'ggml-small.bin';
  if WizardIsTaskSelected('model\turbo') then ModelFile := 'ggml-large-v3-turbo-q5_0.bin';
  if WizardIsTaskSelected('model\base') then ModelFile := 'ggml-base.bin';
  if not WizardIsTaskSelected('model') then ModelFile := '';

  DownloadPage.Show;
  try
    if WizardIsTaskSelected('ffmpeg') then
    begin
      SetArrayLength(U, 2);
      U[0] := '{#FfmpegUrl1}';
      U[1] := '{#FfmpegUrl2}';
      GotFfmpeg := TryDownload(U, 'ffmpeg.zip');
      if not GotFfmpeg then Failed := Failed + #13#10 + '- FFmpeg';
    end;
    if WizardIsTaskSelected('whisper') then
    begin
      SetArrayLength(U, 2);
      U[0] := '{#WhisperUrl1}';
      U[1] := '{#WhisperUrl2}';
      GotWhisper := TryDownload(U, 'whisper.zip');
      if not GotWhisper then Failed := Failed + #13#10 + '- Whisper';
    end;
    if ModelFile <> '' then
    begin
      SetArrayLength(U, 1);
      U[0] := '{#ModelBase}' + ModelFile;
      GotModel := TryDownload(U, ModelFile);
      if not GotModel then Failed := Failed + #13#10 + '- ' + ModelFile;
    end;
  finally
    DownloadPage.Hide;
  end;

  if Failed <> '' then
    MsgBox('Şu bileşenler indirilemedi:' + Failed + #13#10#13#10 +
      'Kurulum devam edecek. Eksikleri daha sonra panelin "Ayarlar" sekmesinden indirebilirsiniz.',
      mbInformation, MB_OK);
end;

procedure ExtractZip(Zip, Dest: String);
var
  RC: Integer;
  Ok: Boolean;
begin
  ForceDirectories(Dest);
  Ok := Exec(ExpandConstant('{sys}\tar.exe'), '-xf "' + Zip + '" -C "' + Dest + '"', '', SW_HIDE, ewWaitUntilTerminated, RC) and (RC = 0);
  if not Ok then
    Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath ''' + Zip +
      ''' -DestinationPath ''' + Dest + ''' -Force"', '', SW_HIDE, ewWaitUntilTerminated, RC);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Root, Src, Dst: String;
begin
  if CurStep <> ssPostInstall then Exit;
  Root := ToolsRoot();
  ForceDirectories(Root + '\tools');
  ForceDirectories(Root + '\models');
  if GotFfmpeg then
  begin
    WizardForm.StatusLabel.Caption := 'FFmpeg açılıyor...';
    DelTree(Root + '\tools\ffmpeg', True, True, True);
    ExtractZip(ExpandConstant('{tmp}\ffmpeg.zip'), Root + '\tools\ffmpeg');
  end;
  if GotWhisper then
  begin
    WizardForm.StatusLabel.Caption := 'Whisper açılıyor...';
    DelTree(Root + '\tools\whisper', True, True, True);
    ExtractZip(ExpandConstant('{tmp}\whisper.zip'), Root + '\tools\whisper');
  end;
  if GotModel and (ModelFile <> '') then
  begin
    WizardForm.StatusLabel.Caption := 'Model kopyalanıyor...';
    Src := ExpandConstant('{tmp}\') + ModelFile;
    Dst := Root + '\models\' + ModelFile;
    DeleteFile(Dst);
    if not RenameFile(Src, Dst) then
      FileCopy(Src, Dst, False);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Root: String;
begin
  if CurUninstallStep <> usPostUninstall then Exit;
  Root := ToolsRoot();
  if DirExists(Root) then
    if MsgBox('İndirilen araçlar, yapay zeka modelleri ve önbellek de silinsin mi?' + #13#10 + Root,
      mbConfirmation, MB_YESNO) = IDYES then
      DelTree(Root, True, True, True);
end;
