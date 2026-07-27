# 📦 ResiScanner - PDF Product & Size Detector

Aplikasi web dan Android untuk membaca, mendeteksi, dan merekapitulasi data pesanan dari file resi PDF secara otomatis. Terintegrasi langsung dengan database **Aiven MySQL** untuk manajemen stok produk dan riwayat inventarisasi.

---

### ✨ Fitur Utama

- **📄 Ekstraksi & Deteksi Resi PDF**:
  - Memproses satu atau beberapa file PDF pesanan sekaligus.
  - Membaca nama produk, varian ukuran, dan kuantitas (`qty`) secara otomatis.
- **⚖️ Penyatuan Ukuran (Unit Normalization)**:
  - Otomatis menyatukan satuan `Liter` (`L`, `1L`, `5L`) ke dalam satuan `KG` (`1KG`, `5KG`) agar rekapitulasi stok konsisten.
- **📊 Tampilan Rekap Ringkas & Mobile-Friendly**:
  - Rekap per Varian Ukuran (Ukuran 1, 5, 20, 25) dengan kartu akordeon (*Minimize by default* untuk tampilan HP yang rapi).
  - Rekap per Produk Unik dan tabel detail baris mentah.
- **💾 Sinkronisasi Database MySQL (Aiven Cloud)**:
  - Menyimpan transaksi **Stok Keluar (OUT / Resi Penjualan)** maupun **Stok Masuk (IN / Restock)** ke database `inventory`.
  - **Perlindungan Stok**: Kueri menggunakan `GREATEST(0, stock - qty)` sehingga stok **tidak akan pernah bernilai negatif**.
  - Pilihan tanggal transaksi khusus dan penyesuaian Sales Channel / Supplier Name (`Gudang`).
  - Generator script kueri SQL otomatis & fitur unduh file `.sql`.
- **📱 Aplikasi Android Native (Capacitor)**:
  - Dilengkapi file installer **`app-debug.apk`**.
  - **Fitur "Buka Dengan / Open With PDF"**: Membuka file PDF langsung dari WhatsApp, File Manager, Telegram, atau Chrome menggunakan aplikasi ini.

---

### 🚀 Cara Menjalankan Project (Development)

#### Persyaratan:
- Node.js (v18+) & npm

#### Langkah-langkah:
1. **Clone repositori**:
   ```bash
   git clone https://github.com/Moharrafi/ResiScanner.git
   cd ResiScanner
   ```

2. **Install dependency**:
   ```bash
   npm install --legacy-peer-deps
   ```

3. **Jalankan dev server**:
   ```bash
   npm run dev
   ```
   Buka `http://localhost:3000` di browser.

---

### 📱 Build Aplikasi Android (APK)

Project ini menggunakan **Capacitor** untuk dikompilasi menjadi aplikasi Android:

```bash
# 1. Build aset web production
npm run build

# 2. Sinkronisasi aset ke folder Android
npx cap sync android

# 3. Kompilasi APK (Windows)
cd android
.\gradlew.bat assembleDebug
```
Hasil file APK tersimpan di `android/app/build/outputs/apk/debug/app-debug.apk` dan di-copy ke folder utama `app-debug.apk`.

---

### 🛠️ Tech Stack

- **Framework & UI**: React 19, TypeScript, TanStack Start (Nitro), TailwindCSS v4, Lucide Icons, Shadcn UI
- **PDF Parser**: PDF.js (`pdfjs-dist`)
- **Database**: MySQL2 & Aiven Cloud MySQL (`inventory` DB)
- **Mobile Native**: Capacitor v7 (Android SDK 35/36)
