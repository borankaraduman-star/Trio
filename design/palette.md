# Trio — renk paleti

| Rol | HEX | Kullanım |
|---|---|---|
| Arka plan / taban | `#111318` | Ana uygulama ve katılım ekranı zemini. |
| Arka plan / yan panel | `#171A20` | Kanal çekmecesi ve üye listesi. |
| Yüzey | `#1A1D24` | Kartlar, mesaj alanı ve ses kontrol paneli. |
| Yükseltilmiş yüzey | `#232730` | Açılır menüler ve etkileşimli kontrol zeminleri. |
| Kenarlık | `#2B303A` | Panelleri ve giriş alanlarını ayıran ince çizgiler. |
| Metin | `#F2F1ED` | Birincil metin ve koyu sistem tepsisi simgesi. |
| İkincil metin | `#A0A6B2` | Zaman damgaları, açıklamalar ve pasif kontroller. |
| Vurgu | `#EE997F` | Üç noktalı marka, seçili kanal ve birincil eylemler. |
| Çevrimiçi | `#69B9AA` | Çevrimiçi durum noktaları ve ses bağlantısı. |
| Konuşuyor | `#85D9C5` | Konuşan katılımcının halkası ve ses göstergesi. |
| Tehlike | `#E4777F` | Aramayı sonlandırma ve yıkıcı eylemler. |
| Konsept B yardımcı rengi | `#DDB174` | Yalnız alternatif logo konseptindeki sıcak üçüncü daire. |

## Marka ve üretim

Uygulama ikonu için A konsepti seçildi: üç arkadaş için üç mercan nokta. B ve C alternatifleri seçim için saklandı. İkon zemini opaktır; platformun yuvarlatılmış kare maskesine uygundur. Tepsi varyantları aynı üç noktalı motifin tek renkli sürümüdür; macOS template pikselleri saf siyahtır ve yalnız alfa kanalı kenar yumuşatması taşır.

Görseller yerleşik image_gen ile üretildi. Küçük manifest, favicon ve tepsi boyutları büyük kaynaklardan Pillow Lanczos ile küçültüldü. Üretim aracının döndürdüğü join ve masaüstü mockup kaynakları hedef boyuttan küçük olduğundan bu iki dosya hedefe Lanczos ile büyütüldü; mobil mockup hedef oranına yeniden örneklendi. Mockup ve illüstrasyonlardaki yumuşak geçişler bu HEX değerlerinin tonlarını içerir.

Prompt özeti: A = koyu zeminde üç mercan nokta; B = mercan/kehribar/turkuaz üç örtüşen daire; C = buluşan üç ses dalgası; tray = şeffaf zeminde üç açık renk nokta; join = merkezi boş koyu soyut daireler; empty-chat = üç konuşma balonu; empty-voice = kulaklık ve üç ses çubuğu; main = Türkçe üç sütunlu sohbet, ekran paylaşımı ve beş ses kontrolü; mobile = aynı uygulamanın açık kanal çekmecesi.
