# Mustika Gamers (server online)

- `server.js`  server Node.js: ruang, login, posisi pemain, chat, sinyal WebRTC, laporan pemain
- `public/index.html`  klien game 3D (Three.js dari CDN)

## Menjalankan di komputer
1. Pasang Node.js 18 atau lebih baru.
2. `npm install` lalu `npm start`.
3. Buka http://localhost:3000 (kamera dan mikrofon boleh dipakai di localhost).
4. Uji online: buka dua tab dengan kode ruang yang sama dan pilih game yang sama.

## Siapa saja boleh bergabung
- **Kode ruang**: kosong = ruang UMUM; atau ketik/buat kode 3-8 huruf/angka. Pemain hanya melihat pemain di ruang dan game yang sama. Satu ruang maksimal 40 pemain (`MAX_ROOM`).
- **Tautan undangan**: tombol 🔗 di dalam game menyalin `alamat-situs/?room=KODE`.
- **Kelas / Asal**: pilihan "Tamu" untuk pemain umum, atau kelas 7A sampai 9D.
- **Kata sandi**: bawaan `karuhun83`. Ubah dengan variabel `GAME_PASSWORD`. Jika `GAME_PASSWORD=` dikosongkan, game terbuka tanpa kata sandi.

## Akun dan moderator
- Pemain memilih **Tamu** (kata sandi permainan), **Masuk**, atau **Daftar** (nama akun + kata sandi minimal 6 karakter). Akun disimpan di `data/users.json` dengan kata sandi ter-hash (scrypt). Nama tampil pemain berakun dikunci.
- Admin pertama dibuat dari variabel `ADMIN_USER` dan `ADMIN_PASS` saat server dinyalakan. Admin mengangkat moderator dari **/admin.html**.
- Moderator dan admin: bisukan 10 menit, keluarkan (blokir sementara 10 menit), lihat pemain online dan laporan. Admin juga bisa memblokir akun dan mengatur peran.
- Tombol Bisukan/Keluarkan juga muncul di daftar pemain 👥 dalam game untuk moderator.
- `ALLOW_GUEST=0` menutup akses tamu, sehingga hanya pemain berakun yang bisa masuk.
- Simpan folder `data/` di penyimpanan permanen (disk/volume) saat dipasang di hosting, agar akun tidak hilang.

## Menayangkan
Kamera dan mikrofon hanya berfungsi lewat **HTTPS** (Render, Railway, Fly.io, atau VPS dengan Caddy/Nginx). Perintah mulai `npm start`; port dari `PORT`.
Untuk jaringan yang ketat (sekolah, kantor) siapkan server TURN: isi `TURN_URL`, `TURN_USER`, `TURN_PASS`.

## Keamanan pemain
- Kamera dan mikrofon mati secara bawaan dan meminta persetujuan sebelum menyala.
- Filter kata kasar di chat (pesan yang kena filter tidak terkirim), batas kecepatan pesan, dan tombol Bisukan / Lapor di daftar pemain 👥. Laporan tercatat di `reports.log`.
- Tambahkan moderator manusia untuk ruang publik. Filter otomatis tidak menangkap semuanya.

## Batasan
- Video/suara memakai jaringan mesh: nyaman sampai sekitar 6 pemain per game. Untuk lebih banyak, pakai SFU (mis. LiveKit).
- Gerakan pemain dipercaya dari klien (belum ada anti-curang).
- Grafis: bloom, FXAA, tekstur prosedural, langit gradasi, outline karakter, tiga tingkat kualitas. Model 3D buatan seniman (glTF), animasi karakter, dan efek suara studio perlu aset tambahan.
