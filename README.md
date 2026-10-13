# Podcast Kurgu Asistanı — Adobe Premiere Pro eklentisi (Windows)

Premiere Pro'nun içinde çalışan bir panel. Podcast kurgusundaki tekrarlayan işleri otomatikleştirir:

| Özellik | Ne yapar |
|---|---|
| **Boşluk kesme** | Konuşmalar arasındaki sessizlikleri bulur, ayarladığınız payları bırakarak keser. |
| **Takılma kesme** | "ıı", "ııı", "ımm", "mmm", "eee", "hmm" gibi takılmaları bulur ve çevresindeki boşlukla birlikte keser. |
| **Altyazı** | Konuşmayı yapay zekâyla (Whisper) yazıya döker, takılmaları ayıklar, kesimlere göre zamanlar ve Premiere'de altyazı kanalı oluşturur. |
| **Çoklu kamera** | Her konuşmacının mikrofonundan kimin konuştuğunu bulur, konuşanın kamerasına geçer; aynı anda konuşulunca geniş açıya döner. |
| **İnce ayar** | Tüm eşikler kaydırıcılarla ayarlanır; analiz bir kez yapılır, değişiklikler anında önizlenir. Tek tek kesimleri açıp kapatabilirsiniz. |

Orijinal sekansınıza dokunulmaz: sonuç **yeni bir sekans** olarak oluşturulur (ya da isterseniz yalnızca **işaretçi** eklenir).

## Neden Premiere içinde bir panel + setup.exe?

- **Panel (CEP eklentisi):** Kesimler zaman çizelgesine uygulanmalı, altyazı kanalı oluşturulmalı, oynatma kafası taşınmalı. Bunlar yalnızca Premiere'in içinden yapılabilir; ayrı bir program kullanıcıyı sürekli dosya alıp vermeye zorlardı.
- **Kurulum programı (setup.exe):** Panelin kendisini doğru klasöre kopyalar, imzasız eklentilere izin veren kayıt defteri ayarını yapar ve ağır bileşenleri (FFmpeg, Whisper ve yapay zekâ modeli) indirir. Yönetici izni gerektirmez.

## Kurulum

1. `PodcastKurgu-Setup-1.0.0.exe` dosyasını indirin:
   - GitHub'da **Actions → "Test ve Windows kurulum dosyası" → son çalışma → Artifacts → PodcastKurgu-Setup**, ya da
   - bir `v1.0.0` etiketi gönderildiyse **Releases** sayfasından.
2. Çalıştırın ve indirilecek bileşenleri seçin:
   - **FFmpeg** — zorunlu (ses çözme).
   - **Whisper** — altyazı ve yapay zekâ ile takılma tespiti için.
   - **Model** — *Small* önerilir; en iyi Türkçe doğruluğu için *Large v3 Turbo Q5*.
3. Premiere Pro'yu yeniden başlatın ve paneli **Pencere › Uzantılar › Podcast Kurgu Asistani** menüsünden açın.

İndirme sırasında sorun olursa kurulum yine tamamlanır; eksikleri panelin **Ayarlar** sekmesinden tek tıkla indirebilirsiniz.

**Setup.exe olmadan kurulum:** `installer\install.bat` dosyasını çalıştırın (eklentiyi kopyalar, kayıt defteri ayarını yapar).

**Uyumluluk:** Windows 10/11 (64-bit), Premiere Pro 2021 (v15) ve sonrası (2022–2026 dahil).

## Kullanım

1. Podcast sekansınızı açın. Her mikrofon ayrı bir ses kanalında olsun (A1 sunucu, A2 konuk…).
2. Panelde **⟳** ile sekansı okuyun; analiz edilecek ses kanallarını işaretleyin. Tek dosyada birden fazla mikrofon kanalı varsa (ör. Zoom/Rode kaydedici), her satırdaki **Kanal** seçicisiyle hangi kanalın kullanılacağını belirtin.
3. **Görevler**den istediklerinizi seçin ve **1 · Analiz et**'e basın.
4. Sonuç kartında yeni süreyi, kazancı ve tüm kesimleri görürsünüz:
   - Ayar sekmelerindeki kaydırıcılar anında yansır (yeniden analiz gerekmez).
   - Bir satırın kutusunu kaldırarak o kesimi iptal edin; **▶** ile Premiere'de o noktaya gidin.
   - Üstteki grafikte kırmızı = boşluk, turuncu = takılma, alttaki renkli şerit = kamera.
5. **2 · Premiere'e uygula**:
   - **Yeni sekans oluştur:** "<sekans adı> - Podcast Kurgu" adlı yeni sekans "Podcast Kurgu" klasörüne eklenir ve açılır. Altyazı seçiliyse altyazı kanalı da eklenir.
   - **Yalnızca işaretçi ekle:** Kesmeden önce incelemek için boşluklar (kırmızı), takılmalar (turuncu) ve kamera geçişleri (mavi) işaretçi olarak eklenir. **İşaretçileri temizle** yalnızca bu panelin eklediklerini siler.

> İpucu: Kesimlerde "çıt" sesi duyarsanız yeni sekansta tüm klipleri seçip **Sekans › Varsayılan geçişi seçime uygula** (Shift+D) ile kısa ses geçişleri ekleyin.

### Çoklu kamera için hazırlık

- Her kamerayı ayrı bir video kanalına (V1, V2, V3…) senkron yerleştirin; mikrofonlar ayrı ses kanallarında olsun.
- **Kamera** sekmesinde her mikrofonu kendi kişisinin kamerasına eşleyin, varsa **Geniş açı** kanalını seçin.
- Pasif kameralar varsayılan olarak *devre dışı* bırakılır (zaman çizelgesinde kalır, istediğiniz anda açıp kapatabilirsiniz) ya da tamamen *silinebilir*.

## Ayarlar (ince ayar)

### Boşluk
| Ayar | Açıklama | Varsayılan |
|---|---|---|
| Otomatik eşik / Hassasiyet | Gürültü tabanı ile konuşma seviyesi arasında eşik. Yükseltirseniz daha çok yer "sessiz" sayılır. | açık / %35 |
| Eşik (elle) | Otomatik kapalıyken sabit dB eşiği. | −42 dB |
| En kısa boşluk | Bundan kısa sessizlikler doğal duraklamadır, kesilmez. | 450 ms |
| Konuşma bitince / başlamadan önce bırakılan pay | Kesimden sonra kalan nefes payı. Toplamı, kesim sonrası kalan duraklamadır. | 120 / 80 ms |
| En kısa kesim | Bundan kısa kesimler yapılmaz. | 150 ms |
| Kısa ses patlamalarını yok say | Tık, masaya vurma gibi kısa sesler konuşma sayılmaz. | 80 ms |
| Nefes seslerini de boşluk say | Kısa, gürültü benzeri, alçak sesleri (nefes) boşluk sayar. | kapalı |

**Hazır ayarlar:** Doğal · Dengeli (önerilen) · Dinamik (YouTube) · Agresif (jump-cut).

### Takılma
- **Yöntem:**
  - *Yapay zekâ (Whisper):* Konuşmayı kelime kelime tanır ve listedeki takılmaları bulur. Kelimeye bitişik takılmaları ("ve-eee") da yakalar.
  - *Akustik:* Model gerektirmez; sabit perdeli, sabit tınılı uzun sesleri (ıııı, mmmm) bulur. Varsayılan olarak yalnızca konuşmanın arasına giren takılmaları keser (kelimeleri kırpmamak için).
  - *Otomatik:* Whisper kuruluysa yapay zekâyı, değilse akustik yöntemi kullanır. *İkisi birlikte* en kapsamlısıdır.
- **Takılma kelimeleri:** Virgülle ayrılmış liste. Harf tekrarı önemsizdir ("ıı" yazmak "ıııııı"yı da yakalar). "şey", "yani" gibi gerçek kelimeleri eklerken dikkatli olun.
- **Whisper ipucu metni:** Whisper normalde takılmaları yazıya dökmez; bu metin onu takılmaları da yazmaya yönlendirir.

### Altyazı
Satır başına karakter (42), satır sayısı (2), altyazı başına en fazla kelime (Shorts/Reels için 1–3), en kısa/en uzun süre, yeni altyazı başlatma boşluğu, zaman kaydırma, takılmaları çıkarma, BÜYÜK HARF (Türkçe i/İ doğru), noktalama kaldırma. **SRT kaydet** ve **Transkript kaydet** ile dosya olarak da alabilirsiniz. Görünüm (yazı tipi, renk, konum) Premiere'in altyazı stilleriyle ayarlanır.

### Kamera
Baskınlık farkı (konuşmacının diğerlerinden kaç dB yüksek olması gerektiği), kısa araya girmeleri yok sayma ("evet", "hı hı" kamera değiştirmez), en kısa çekim, önden geçiş (kamera, konuşma başlamadan biraz önce değişir), yumuşatma, örtüşmede geniş açı, mikrofon seviyelerini otomatik eşitleme, uzun çekimlerde ara plan (geniş açı veya dinleyen kişinin tepki çekimi).

## Nasıl çalışır?

```
Premiere sekansı ──(ExtendScript)──► klip listesi
        │
        ▼
FFmpeg: her klibin sesi 16 kHz mono ──► 10 ms'lik ses seviyesi zarfları ──► sessizlik / konuşmacı tespiti
        │                                                              └──► akustik takılma özellikleri
        └──► karışık ses ──► whisper.cpp (kelime zaman damgalı) ──► takılmalar + altyazı
                                    │
                         planlama (anında, ince ayarla)
                                    │
Premiere ◄── yeni sekans (FCP XML ile) + SRT altyazı kanalı ◄──┘
```

- Kesimler, sekans Final Cut Pro XML olarak dışa aktarılıp her kanalda **aynı karelerden** yeniden kurularak uygulanır; böylece görüntü ve tüm ses kanalları senkron kalır.
- Whisper sonuçları önbelleğe alınır: aynı sekansı tekrar analiz etmek anında biter.
- Tüm işlem bilgisayarınızda yapılır; ses hiçbir sunucuya gönderilmez.

Araçlar ve modeller `%LOCALAPPDATA%\PodcastKurgu` altında tutulur (Windows kullanıcı adınız Türkçe karakter içeriyorsa `C:\Users\Public\PodcastKurgu`).

## Sorun giderme

| Sorun | Çözüm |
|---|---|
| Panel menüde yok | Kurulumu tekrar çalıştırın (kayıt defterinde `HKCU\Software\Adobe\CSXS.<sürüm>\PlayerDebugMode = 1` olmalı) ve Premiere'i yeniden başlatın. |
| "FFmpeg bulunamadı" | Ayarlar › Bileşenler › FFmpeg › İndir; ya da kendi `ffmpeg.exe` yolunuzu girin. |
| Whisper yavaş | Daha küçük model (Base/Small) seçin; NVIDIA kartınız varsa whisper.cpp'nin CUDA sürümünü indirip yolunu **Özel yollar**a girin. |
| Bir klip "çözülemedi" uyarısı | İç içe sekans (nested) ya da birleştirilmiş klipler (merged clip) analiz edilemez; mikrofon kayıtlarını doğrudan ses kanallarına koyun. |
| Kesimler kelime başlarını kırpıyor | "Konuşma başlamadan önce bırakılan pay"ı artırın veya hassasiyeti düşürün. |
| Kamera çok sık değişiyor | "En kısa çekim" ve "Kısa araya girmeleri yok say" değerlerini artırın, "Baskınlık farkı"nı yükseltin. |

**Bilinen sınırlar:** XML aktarımında geçiş efektleri (transition) kaldırılır, anahtar kareli efektler parçalara bölünen kliplerde kayabilir; Lumetri/Essential Graphics gibi bazı efektler FCP XML'e aktarılmayabilir. Bu yüzden eklentiyi ham kurgu aşamasında, renk ve grafik işlerinden önce kullanmanız önerilir.

## Geliştirme

```
extension/            Premiere'e kurulan CEP eklentisi
  CSXS/manifest.xml   eklenti tanımı (Node.js etkin)
  index.html, css/    panel arayüzü
  js/main.js          arayüz denetleyicisi
  js/cep.js           Premiere (ExtendScript) köprüsü
  js/lib/             analiz ve kurgu mantığı (Node ile test edilebilir)
  jsx/host.jsx        Premiere içinde çalışan ExtendScript
installer/            Inno Setup betiği (setup.exe) ve elle kurulum betikleri
tests/                birim, uçtan uca (gerçek FFmpeg) ve arayüz testleri
```

```bash
npm ci
npm test                       # birim + uçtan uca testler (FFmpeg gerekir)
node tests/ui/ui-check.js      # arayüz testi (Playwright + Chromium gerekir)
```

Kurulum dosyası her gönderimde GitHub Actions ile Windows üzerinde derlenir (`.github/workflows/build.yml`). Yerelde derlemek için Inno Setup 6 kurup `ISCC.exe installer\PodcastKurgu.iss` çalıştırın.

Geliştirme sırasında panelin hata ayıklayıcısı için `extension/.debug` dosyası `http://localhost:8098` adresini açar (kurulum programı bu dosyayı kopyalamaz).

**Üçüncü taraf bileşenler** (depoda bulunmaz, kurulumda kullanıcının bilgisayarına indirilir): [FFmpeg](https://ffmpeg.org) (LGPL/GPL), [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT), OpenAI Whisper modelleri (MIT).
