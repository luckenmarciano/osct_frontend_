# Product Requirements Document — OSCT

**Oil Spill Combat Training — Platform Pelatihan Maritim OPRC**

| | |
|---|---|
| **Versi** | 1.0 |
| **Tanggal** | 21 Mei 2026 |
| **Status** | Living document — di-reverse-engineer dari aplikasi produksi |
| **Tujuan dokumen** | (1) Acuan pengembangan lanjutan, (2) Spesifikasi cukup detail untuk membangun ulang dari nol |
| **Repositori** | `osct_backend` (Node.js/Express + Prisma), `osct_frontend` (React + Vite) |

---

## Daftar Isi

1. [Ringkasan Eksekutif](#1-ringkasan-eksekutif)
2. [Konteks Bisnis & Tujuan Produk](#2-konteks-bisnis--tujuan-produk)
3. [Pengguna & Peran](#3-pengguna--peran)
4. [Arsitektur Sistem](#4-arsitektur-sistem)
5. [Konsep Inti: Program Isolation](#5-konsep-inti-program-isolation)
6. [Functional Requirements](#6-functional-requirements)
7. [Data Model](#7-data-model)
8. [API Surface](#8-api-surface)
9. [Business Rules Penting](#9-business-rules-penting)
10. [Non-Functional Requirements](#10-non-functional-requirements)
11. [Roadmap & Backlog](#11-roadmap--backlog)
12. [Lampiran](#12-lampiran)

---

## 1. Ringkasan Eksekutif

OSCT adalah platform pelatihan maritim berbasis web untuk sertifikasi **OPRC** (Oil Pollution Preparedness, Response and Co-operation — konvensi IMO untuk penanggulangan tumpahan minyak). Platform ini melayani tiga jenjang pelatihan — **OPRC Level 1, 2, dan 3** — yang dijalankan oleh lembaga pelatihan maritim untuk operator kapal, personel pelabuhan, dan ekosistem migas.

Platform menggabungkan:

- **Learning Management** — kursus, modul, video pembelajaran dengan pelacakan progres.
- **Asesmen** — pretest/posttest tingkat program + quiz per-lesson, dengan auto-grading MCQ dan penilaian esai oleh trainer.
- **Sesi tatap muka** — penjadwalan, RSVP, presensi via QR + geo-fence.
- **Sertifikasi** — penerbitan otomatis, klaim mandiri oleh peserta, verifikasi publik.
- **AI Assistant** — chatbot berbasis RAG yang menjawab dari Knowledge Base per program.
- **Pelaporan & Analitik** — laporan progres, kehadiran, learning gain; ekspor CSV/PDF.

Karakteristik arsitektur yang membedakan: **isolasi penuh per program**. Setiap data (kursus, peserta, sesi, sertifikat, KB) terikat ke satu `OPRCProgram`, dan akses lintas program dicegah di lapisan middleware.

**Status saat ini:** aplikasi sudah berjalan di produksi (Vercel) dengan seluruh modul inti fungsional. Pekerjaan yang sedang berjalan: pass *mobile responsive* di frontend.

---

## 2. Konteks Bisnis & Tujuan Produk

### 2.1 Masalah yang Diselesaikan

Lembaga pelatihan OPRC di Indonesia umumnya menjalankan pelatihan secara manual: pendaftaran via spreadsheet, presensi kertas, soal cetak, sertifikat dibuat manual. Hal ini menyulitkan:

- Pelacakan progres dan *learning gain* per peserta dan per batch.
- Pembuktian kehadiran yang auditable (penting untuk pelatihan yang diregulasi IMO).
- Penerbitan dan verifikasi keaslian sertifikat.
- Standardisasi materi dan asesmen lintas batch.

### 2.2 Tujuan Produk

| Tujuan | Indikator Keberhasilan |
|---|---|
| Digitalisasi siklus pelatihan OPRC end-to-end | Satu peserta dapat dienroll → belajar → ujian → hadir sesi → terima sertifikat tanpa proses manual |
| Pembuktian kehadiran yang auditable | Presensi QR + geo-fence + audit log, kehadiran dihitung otomatis |
| Mengukur efektivitas pelatihan | Learning gain (posttest − pretest) terukur per peserta dan per batch |
| Verifikasi sertifikat oleh pihak ketiga | Halaman verifikasi publik dengan nomor sertifikat |
| Isolasi data antar program & antar lembaga | Tidak ada kebocoran data lintas program |

### 2.3 Target Pasar

Lembaga pelatihan maritim, otoritas pelabuhan, perusahaan migas (mis. Pertamina dan ekosistemnya), dan operator kapal yang membutuhkan sertifikasi OPRC sesuai regulasi IMO.

### 2.4 Di Luar Cakupan (Non-Goals)

- Bukan platform e-learning umum — khusus domain OPRC/maritim.
- Tidak menangani pembayaran/penagihan peserta (versi saat ini).
- Tidak ada aplikasi mobile native — web responsive saja.

---

## 3. Pengguna & Peran

Sistem memiliki 4 peran (`UserRole` enum). Frontend menyederhanakan menjadi 3 kelompok: `admin` (SUPER_ADMIN + PROGRAM_ADMIN), `trainer`, `participant`.

| Peran | Enum | Deskripsi & Wewenang |
|---|---|---|
| **Super Admin** | `SUPER_ADMIN` | Akses penuh seluruh program. Membuat/mengelola program, menugaskan trainer, mengelola seluruh pengguna. |
| **Program Admin** | `PROGRAM_ADMIN` | Mengelola program tempat ia ditugaskan: konten, peserta, asesmen, sesi, sertifikat. |
| **Trainer** | `TRAINER` | Mengajar program yang ditugaskan kepadanya. Mengelola sesi, presensi, menilai esai, melihat laporan kelas. |
| **Participant** | `PARTICIPANT` | Peserta pelatihan. Mengikuti kursus, ujian, sesi; mengklaim sertifikat; memakai AI Assistant. |

**Catatan akses:**
- Akses program seseorang = gabungan (union) dari *enrollment*-nya (sebagai peserta) dan *trainer assignment*-nya. Disimpan sebagai `programIds` dalam JWT.
- Satu pengguna bisa terdaftar di beberapa program; UI menyediakan *Program Switcher*.

---

## 4. Arsitektur Sistem

### 4.1 Tech Stack

| Lapisan | Teknologi |
|---|---|
| Frontend | React 18 + Vite, **tanpa router library** (state halaman di `AppContext`) |
| Backend | Node.js + Express, dibungkus `serverless-http` untuk Vercel |
| ORM | Prisma |
| Database | PostgreSQL (Supabase) + ekstensi **pgvector** |
| Storage | Supabase Storage (bucket `videos`, `kb-docs`) |
| Auth | JWT (access + refresh token) |
| Email | Resend |
| AI | Google Gemini (chat + `text-embedding-004`, 768 dimensi) |
| Hosting | Vercel (frontend static build + backend serverless functions) |
| Cron | Vercel Cron |

### 4.2 Struktur Deploy

- **Database:** Supabase Postgres. `DATABASE_URL` memakai pooler (port 6543) untuk runtime; `DIRECT_URL` (port 5432) untuk migrasi.
- **Backend:** Vercel serverless functions. Migrasi dijalankan lokal (`prisma migrate deploy`), tidak pernah saat runtime.
- **Frontend:** Vite static build di Vercel.
- **Cron:** `vercel.json` menjalankan reminder sesi harian pukul 01:00 UTC.

### 4.3 Pola Frontend

- Tidak ada library routing; halaman aktif disimpan di `AppContext` (`page` + `pageState`).
- `currentProgramId` disimpan di `AppContext` + `localStorage`.
- Variabel CSS `--program-color` di-inject ke `<html>` agar tema per-program berjalan tanpa prop drilling.
- API call selalu menyematkan `pid` di URL (mis. `/programs/:pid/enrollments`).

### 4.4 Pola Backend

- Setiap route yang menyentuh resource per-program memasang middleware `verifyJWT` → `programIsolation`.
- Middleware `programIsolation` mengeset `req.programId` dari parameter URL `:pid`/`:programId` dan memvalidasi pengguna berhak atas program tersebut.
- Akses Prisma untuk model `OPRCProgram` memakai `prisma.oPRCProgram` (konvensi penamaan Prisma).

---

## 5. Konsep Inti: Program Isolation

Ini adalah prinsip arsitektur paling fundamental dan **wajib dipertahankan pada setiap fitur baru**.

### 5.1 Aturan

1. Setiap tabel resource yang dimiliki sebuah program **wajib** punya kolom `program_id` dan relasi ke `OPRCProgram`.
2. Setiap endpoint resource per-program **wajib** memuat `:pid` di URL dan memasang middleware `programIsolation`.
3. **Dilarang** membuat endpoint datar `/resource/:id` yang melewati isolasi.
4. JWT membawa `programIds` (union enrollment + trainer assignment). Middleware menolak akses bila `:pid` tidak ada di dalamnya.
5. Frontend menyimpan `currentProgramId` dan menyematkannya ke setiap pemanggilan API.

### 5.2 Dampak ke Data Model

Model yang membawa `program_id`: `ProgramEnrollment`, `ProgramTrainer`, `ParticipantLoginQR`, `Course`, `CourseTest`, `Session`, `Certificate`, `KnowledgeBaseDoc`, `KnowledgeBaseChunk`, `AIConversation`, `AuditLog`, `VideoWatchSession`, `VideoBookmark`, `TestAttempt`, `LessonProgress`, `Attendance`, `QuizAttempt`.

---

## 6. Functional Requirements

**Legenda status:** ✅ Shipped (sudah produksi) · 🔧 Partial (sebagian) · 📋 Planned (roadmap)

Setiap FR memuat: deskripsi, acceptance criteria, dan referensi data/endpoint. Penomoran FR melanjutkan konvensi tim yang sudah ada.

---

### FR-1 — Autentikasi, Akun & Keamanan Sesi ✅

**Deskripsi:** Pengguna masuk via email+password atau QR. Sesi dijaga dengan access + refresh token. Login QR dari perangkat baru memerlukan konfirmasi perangkat.

**FR-1.1 Login Password** ✅
- Login dengan email + password; password di-hash (bcrypt).
- Sukses → mengembalikan access token (JWT), refresh token, dan profil pengguna.

**FR-1.2 Login QR** ✅
- JWT QR ditandatangani dengan `JWT_QR_SECRET`, masa berlaku 365 hari, `type='qr_login'`.
- QR membawa `userId` + `programId`, sehingga login QR otomatis memilih program.
- QR per peserta-per-program bersifat unik (`ParticipantLoginQR`, unique `[user_id, program_id]`).

**FR-1.3 Refresh Token** ✅
- Endpoint `/auth/refresh` menukar refresh token valid dengan access token baru.
- Refresh token bisa di-`revoked`; punya `expires_at`.

**FR-1.4 Logout** ✅ — Mencabut refresh token.

**FR-1.5 Lupa & Reset Password** ✅
- `/auth/forgot-password` mengirim email berisi tautan/kode reset.
- `/auth/reset-password` menyetel password baru dengan token yang valid.

**FR-1.7 Device Trust** ✅
- Login QR dari *fingerprint* perangkat baru (sha256 dari UA + screen + tz + locale) memunculkan prompt konfirmasi.
- Perangkat yang sudah dikonfirmasi (`confirmed_at`) melewati prompt pada login berikutnya.
- Pengguna dapat melihat & mencabut daftar perangkat tepercaya (`GET/POST/DELETE /auth/devices`).

**Acceptance Criteria:**
- [ ] Password salah → 401, tanpa membocorkan apakah email terdaftar.
- [ ] Access token kedaluwarsa → refresh berhasil tanpa login ulang.
- [ ] Login QR dari perangkat asing → wajib dikonfirmasi sebelum sesi penuh diberikan.
- [ ] Akun `is_active=false` tidak dapat login.

---

### FR-2 — Model Program & Multi-Program Isolation ✅

**Deskripsi:** Entitas `OPRCProgram` adalah unit tenancy. Tiga program standar: `oprc-1`, `oprc-2`, `oprc-3`.

**Acceptance Criteria:**
- [ ] Program punya `code` unik, `name`, `level` (1–3), `color_theme`, `icon`, `description`, `is_active`.
- [ ] Super Admin dapat membuat, mengubah, menonaktifkan program.
- [ ] `GET /programs` hanya mengembalikan program yang dapat diakses pengguna.
- [ ] Tema warna program tampil konsisten di seluruh UI (`--program-color`).
- [ ] Pengguna dengan akses >1 program dapat berpindah via Program Switcher.

---

### FR-3 — Enrollment Peserta ✅

**Deskripsi:** Mendaftarkan peserta ke sebuah program. Enrollment menyimpan skor & status sertifikasi.

**FR-3.1 Enrollment tunggal** ✅ — Admin mendaftarkan satu peserta ke program.

**FR-3.2 Batch Enroll** ✅
- Mendaftarkan banyak peserta sekaligus.
- Saat batch enroll, dipilih **training mode**: `INHOUSE` (cohort 1 perusahaan) atau `PUBLIC` (campuran perusahaan).
- Untuk mode publik, perusahaan tiap peserta dicatat per peserta.

**FR-3.3 Data Enrollment** ✅
- `ProgramEnrollment` menyimpan `pretest_score`, `posttest_score`, `attendance_pct`, `cert_eligible`.
- Unik per `[user_id, program_id]` — peserta tidak dapat double-enroll di program yang sama.

**Acceptance Criteria:**
- [ ] Peserta yang sudah terdaftar tidak dapat didaftarkan ulang ke program yang sama.
- [ ] Batch enroll wajib memilih training mode.
- [ ] `attendance_pct` dan `cert_eligible` ter-update otomatis seiring progres.

---

### FR-4 — Manajemen Pengguna & Import ✅

**FR-4.1 CRUD Pengguna** ✅
- Admin dapat membuat, mengubah, menonaktifkan pengguna (`GET/POST/PUT/DELETE /users`).
- `GET /users/me` mengembalikan profil pengguna saat ini.

**FR-4.2 Import Peserta via CSV** ✅
- Admin mengunggah CSV peserta; sistem memvalidasi dan menampilkan baris bermasalah.
- Data domain maritim disimpan di `ParticipantProfile`: `company_id`, `client_company`, `place/date_of_birth`, `training_type/mode/date`, `nautical_cert_no` + `expires_at`, `hubla_cert_no` + `expires_at`.
- `ParticipantProfile` terpisah dari `User` agar `User` tetap ramping.

**FR-4.3 Generate QR Login Peserta** ✅ — Admin menghasilkan QR login per peserta.

**Acceptance Criteria:**
- [ ] CSV dengan baris cacat → baris valid tetap terimpor, baris cacat dilaporkan dengan alasan.
- [ ] Email duplikat ditolak (unique).
- [ ] Menonaktifkan pengguna mencabut akses tanpa menghapus data historis.

---

### FR-5 — Konten Pembelajaran (Course / Module / Lesson) ✅

**Deskripsi:** Struktur konten 3 tingkat: **Course → Module → Lesson**. Lesson bertipe `VIDEO`, `PDF`, atau `QUIZ`.

**Acceptance Criteria:**
- [ ] Course punya `status` (`DRAFT`/`PUBLISHED`/`ARCHIVED`), `order_index`, opsional `start_date`/`end_date`/`quota`.
- [ ] Module dan Lesson berurutan via `order_index`.
- [ ] Hanya Course `PUBLISHED` yang tampil ke peserta.
- [ ] Admin/trainer dapat membuat & menyusun ulang konten.
- [ ] Course terikat ke satu program (`program_id`).

---

### FR-6 — Video & Pelacakan Progres ✅

**Deskripsi:** Lesson video dengan player, progres tonton, dan bookmark bertimestamp.

**FR-6.1 Pustaka & Unggah Video** ✅
- Video disimpan di Supabase Storage; metadata: `hls_url`, `storage_path`, `duration_sec`, `captions_url`, `thumbnail_url`.

**FR-6.2 Watch Session** ✅
- `VideoWatchSession` mencatat `watch_pct`, `completed`, `last_watched_at` per `[user, video, program]`.

**FR-6.3 Bookmark Video** ✅
- Peserta menandai `timestamp_sec` dengan `note` opsional.

**FR-6.4 Lesson Progress** ✅
- `LessonProgress` menandai lesson selesai per `[user, lesson, program]`.

**Acceptance Criteria:**
- [ ] Progres tonton tersimpan dan dilanjutkan dari posisi terakhir.
- [ ] Lesson otomatis ditandai selesai saat threshold tonton tercapai.
- [ ] Progres terisolasi per program.

---

### FR-7 — Pretest & Posttest ✅

**Deskripsi:** Asesmen tingkat program. Tepat satu PRETEST dan satu POSTTEST per program (`CourseTest`, unique `[program_id, type]`).

**FR-7.1 Penyusunan Soal** ✅
- Editor soal (`TestEditorScreen`): MCQ dan esai.
- Soal MCQ: `options` JSON `[{key, text}]`, `correct_answer` = key. Esai: `correct_answer` null.
- Tiap soal punya `points` dan `order_index`.

**FR-7.2 Pengerjaan Tes** ✅
- Peserta mengerjakan tes dengan navigator soal, timer (`time_limit` menit), indikator terjawab.
- Jawaban tersimpan di `TestAttempt.answers` (JSON).

**FR-7.3 Batas Percobaan** ✅
- `max_attempts` dapat dikonfigurasi admin. Default: 1 untuk PRETEST, 2 untuk POSTTEST.

**FR-7.4 Grading** ✅
- MCQ ter-auto-grade. Esai masuk antrean penilaian trainer (*pending grading*).
- Skor final disimpan ke `TestAttempt.score` dan disalin ke `ProgramEnrollment.pretest_score`/`posttest_score`.

**FR-7.5 Learning Gain** ✅
- Layar Learning Gain menampilkan posttest − pretest per peserta dan rata-rata batch.
- Nilai lulus posttest = **70** (konstanta backend `POSTTEST_THRESHOLD`) — di-enforce sistem untuk kelayakan sertifikat.
- Target *gain* ≥ 20 hanya **target tampilan/aspiratif** di layar tes; **tidak** di-enforce sistem.

**FR-7.6 Cohort & Notifikasi** ✅
- Notifikasi tes (mis. tes baru tersedia, esai sudah dinilai) muncul untuk peserta.

**FR-7.7 Prasyarat Posttest** ✅
- Posttest hanya terbuka setelah **seluruh lesson program selesai** (`isProgramLearningComplete` — semua `LessonProgress.completed = true`).

**Acceptance Criteria:**
- [ ] Posttest terkunci sampai seluruh lesson program selesai.
- [ ] Peserta tidak dapat melebihi `max_attempts`.
- [ ] Timer habis → jawaban tersubmit otomatis.
- [ ] Skor MCQ langsung; esai menunggu trainer.
- [ ] Skor masuk ke enrollment dan ikut menentukan kelayakan sertifikat.

---

### FR-8 — Quiz per-Lesson ✅

**Deskripsi:** Quiz pendek terikat ke satu lesson (`Quiz`, unique `lesson_id`). Berbeda dari pretest/posttest tingkat program.

**Acceptance Criteria:**
- [ ] Quiz punya `passing_score` (default 70) dan `max_attempts` (default 3).
- [ ] `QuizQuestion` mendukung MCQ & esai dengan `points`.
- [ ] `QuizAttempt` mencatat jawaban & skor per `[user, quiz]`.
- [ ] Admin/trainer CRUD soal quiz.

---

### FR-9 — Sesi Tatap Muka & Kehadiran ✅

**Deskripsi:** Sesi pelatihan luring dengan penjadwalan, RSVP, dan presensi QR + geo-fence.

**FR-9.1 Penjadwalan Sesi** ✅
- Sesi punya `title`, `scheduled_at`, `location`, `session_type` (`LECTURE`/`DRILL`/`EXAM`), `duration_min`, `capacity`, `trainer_id`.
- Trainer ditugaskan via `trainerId`, divalidasi terhadap `ProgramTrainer`.

**FR-9.2 Sesi Berulang (Recurring)** ✅
- POST menerima spek `recurrence`; sesi sederi berbagi satu `series_id`.
- `DELETE ?series=true` menghapus seluruh seri.

**FR-9.3 Konflik Jadwal** ✅
- Helper `findSessionConflicts` memunculkan peringatan lunak (*soft warning*) — tidak pernah memblokir.

**FR-9.4 Presensi QR** ✅
- Trainer membuat QR sesi (`QRToken`, ada `expires_at`).
- Peserta scan QR → `Attendance` tercatat per `[session, user]`.
- "End session" (`POST /sessions/:id/qr/stop`) menyetel `is_active=false`.

**FR-9.5 Geo-fence** ✅
- Bila sesi punya `location_lat/lng` + `geo_radius_m`, scan di luar radius ditandai `is_flagged` dengan `flag_reason='geo_outside_fence'`.
- Scan dari `device_id` yang sama berulang ditandai `duplicate_device`.

**FR-9.6 RSVP & Kapasitas** ✅
- Peserta menyatakan `GOING`/`NOT_GOING` (`SessionRSVP`, unique `[session, user]`).
- RSVP `GOING` baru diblokir hanya bila kapasitas penuh.

**FR-9.7 Reminder Sesi** ✅
- Banner in-app di dashboard peserta (diturunkan dari data `upcomingSessions`).
- Email H-1 otomatis via Vercel Cron harian 01:00 UTC; butuh env `CRON_SECRET`.

**FR-9.8 Detail Sesi & Kalender** ✅
- `SessionDetailScreen` menampilkan daftar peserta yang hadir.
- `SessionsScreen` punya tampilan kalender bulanan.

**Acceptance Criteria:**
- [ ] Peserta tidak dapat absen dua kali pada satu sesi.
- [ ] Scan di luar geo-fence tetap tercatat tetapi diberi flag.
- [ ] Konflik jadwal hanya memunculkan peringatan, tidak memblokir simpan.
- [ ] Sesi tanpa `duration_min` diasumsikan 60 menit.
- [ ] Reminder H-1 hanya terkirim sekali (`reminder_sent_at`).

---

### FR-10 — Dashboard per Peran ✅

**Deskripsi:** Tiga dashboard berbeda sesuai peran, plus `ProgramDetailScreen`.

**Acceptance Criteria:**
- [ ] **Participant Dashboard** — lanjutkan belajar, sesi mendatang, status tes & sertifikat.
- [ ] **Trainer Dashboard** — kelas yang diajar, antrean penilaian esai, daftar peserta.
- [ ] **Admin Dashboard** — ringkasan lintas program, aksi cepat (batch enroll, kelola trainer).
- [ ] Seluruh dashboard menampilkan `ProgramBanner` dengan identitas visual program aktif.
- [ ] Tidak menampilkan metrik fiktif — panel tanpa data didukung dihapus, bukan diisi data palsu.

---

### FR-11 — Sertifikasi & Verifikasi Publik ✅

**Deskripsi:** Penerbitan sertifikat OPRC, klaim mandiri oleh peserta, dan verifikasi keaslian oleh publik.

**FR-11.1 Kelayakan Sertifikat** ✅
- `cert_eligible = true` bila **kedua** syarat terpenuhi:
  1. `attendance_pct ≥ 80%` (konstanta `ATTENDANCE_THRESHOLD`)
  2. `posttest_score ≥ 70` (konstanta `POSTTEST_THRESHOLD`)
- `attendance_pct` = (jumlah sesi dihadiri ÷ jumlah sesi yang `scheduled_at`-nya sudah lewat) × 100.
- Dihitung ulang otomatis setiap peserta melakukan scan presensi (`recomputeAttendancePct`).

**FR-11.2 Penerbitan** ✅
- `Certificate` punya `cert_no` unik, `verification_code` unik, `code_expires_at`, `pdf_url`.
- Satu sertifikat per enrollment (unique `enrollment_id`).

**FR-11.3 Pengiriman Kode** ✅
- Admin mengirim kode verifikasi ke peserta via email (`AdminCertSendScreen`).

**FR-11.4 Klaim Mandiri** ✅
- Halaman publik `/claim`: peserta memasukkan email + kode verifikasi 8 karakter → mengunduh PDF sertifikat.

**FR-11.5 Verifikasi Publik** ✅
- `GET /verify/:certNo` — endpoint publik mengkonfirmasi keaslian sertifikat tanpa login.

**Acceptance Criteria:**
- [ ] Kode verifikasi kedaluwarsa setelah `code_expires_at`.
- [ ] Sertifikat hanya terbit untuk enrollment `cert_eligible`.
- [ ] Verifikasi publik tidak membocorkan data sensitif di luar keabsahan + identitas dasar.
- [ ] `claimed_at` tercatat saat sertifikat diklaim.

---

### FR-12 — AI Assistant (RAG) & Knowledge Base ✅

**Deskripsi:** Chatbot AI yang menjawab pertanyaan peserta dari dokumen Knowledge Base program, dengan sitasi sumber.

**FR-12.1 Knowledge Base** ✅
- Admin mengunggah dokumen (`KnowledgeBaseDoc`) ke bucket `kb-docs`.
- Dokumen dipecah menjadi `KnowledgeBaseChunk`, di-embed dengan Gemini `text-embedding-004` (vektor 768 dimensi, kolom `pgvector`).
- `embedded_at` menandai dokumen selesai diproses.

**FR-12.2 Chat RAG** ✅
- `POST /ai/programs/:pid/chat` — pertanyaan di-embed, dicari chunk termirip via pgvector, dikirim ke Gemini sebagai konteks.
- Jawaban menyertakan `sources` (`doc_id`, `filename`, `chunk_text`).

**FR-12.3 Riwayat Percakapan** ✅
- `AIConversation` + `AIMessage` menyimpan riwayat per pengguna-per program.

**FR-12.4 Feedback Jawaban** ✅
- Peserta memberi `UP`/`DOWN` pada jawaban asisten (`POST /ai/messages/:id/feedback`).

**Acceptance Criteria:**
- [ ] Chat hanya mengambil konteks dari KB program aktif (isolasi).
- [ ] Jawaban menampilkan sumber yang dapat ditelusuri.
- [ ] Dokumen yang belum ter-embed tidak dipakai sebagai konteks.

---

### FR-13 — Reports & Ekspor ✅

**Deskripsi:** Laporan untuk admin & trainer, dengan ekspor CSV dan PDF.

**Acceptance Criteria:**
- [ ] **Tab Peserta** — progres & skor per peserta.
- [ ] **Tab Kursus** — progres per kursus, peserta per kursus.
- [ ] **Tab Kehadiran** — laporan presensi per sesi (`/reports/programs/:pid/attendance`).
- [ ] Setiap laporan dapat diekspor `.csv` dan `.pdf`.
- [ ] Laporan terisolasi per program.

---

### FR-14 — Email & Notifikasi ✅

**Deskripsi:** Pengiriman email transaksional & broadcast, dengan log.

**FR-14.1 Jenis Email** ✅ — `CUSTOM`, `BROADCAST`, `SESSION_REMINDER`, `CERT_VERIFICATION`, `PASSWORD_RESET` (`EmailKind`).

**FR-14.2 Broadcast** ✅ — Admin mengirim email ke sekelompok pengguna program.

**FR-14.3 Log Email** ✅ — `EmailLog` mencatat `to_email`, `subject`, `status` (`sent`/`failed`/`mocked`), `error`.

**FR-14.4 Cron Reminder** ✅ — `GET /emails/cron/session-reminders` dipicu Vercel Cron.

**Acceptance Criteria:**
- [ ] Email gagal tetap tercatat dengan `status='failed'` + pesan error.
- [ ] **Keterbatasan diketahui:** Resend dalam mode test hanya mengirim ke pemilik akun sampai domain diverifikasi.

---

### FR-15 — Penugasan Trainer ✅

**Deskripsi:** Admin menugaskan trainer ke program; trainer mendapat notifikasi email + in-app.

**Acceptance Criteria:**
- [ ] `ProgramTrainer` unik per `[user_id, program_id]`.
- [ ] Trainer baru menerima email penugasan.
- [ ] Banner in-app penugasan tampil sampai di-acknowledge (`acknowledged_at`).
- [ ] `GET /programs/trainer/assignments/pending` mengembalikan penugasan yang belum dikonfirmasi.

---

### FR-16 — Analytics Pembelajaran ✅

**Deskripsi:** `ProgressAnalyticsScreen` menampilkan analitik lintas program berbasis data live.

**Acceptance Criteria:**
- [ ] Metrik dihitung dari data nyata (progres, skor, kehadiran) — tanpa data fiktif.
- [ ] Analitik dapat dipecah per program.
- [ ] Distribusi pretest vs posttest dan learning gain ditampilkan.

---

### FR-17 — Audit Log ✅

**Deskripsi:** Pencatatan aksi penting untuk keperluan audit.

**Acceptance Criteria:**
- [ ] `AuditLog` mencatat `action` (mis. `CERT_SENT`, `USER_LOGIN`, `QR_SCANNED`), `resource_type/id`, `metadata`, `ip_address`.
- [ ] Log terkait pengguna & program (nullable, `SetNull` saat induk terhapus).

---

## 7. Data Model

26 model Prisma. Database: PostgreSQL + pgvector. Semua tabel memakai `cuid()` sebagai primary key.

### 7.1 Enum

| Enum | Nilai |
|---|---|
| `UserRole` | SUPER_ADMIN, PROGRAM_ADMIN, TRAINER, PARTICIPANT |
| `LessonType` | VIDEO, PDF, QUIZ |
| `TestType` | PRETEST, POSTTEST |
| `QuestionType` | MCQ, ESSAY |
| `CourseStatus` | DRAFT, PUBLISHED, ARCHIVED |
| `TrainingMode` | INHOUSE, PUBLIC |
| `SessionType` | LECTURE, DRILL, EXAM |
| `RSVPStatus` | GOING, NOT_GOING |
| `AIMessageRole` | USER, ASSISTANT |
| `AIFeedback` | UP, DOWN |
| `EmailKind` | CUSTOM, BROADCAST, SESSION_REMINDER, CERT_VERIFICATION, PASSWORD_RESET |

### 7.2 Entitas & Relasi

**Users & Auth**
- `User` — akun. Relasi ke seluruh aktivitas. Punya `role`, `is_active`.
- `ParticipantProfile` (1–1 User) — data domain maritim (sertifikat nautika, hubla, perusahaan).
- `RefreshToken` — token refresh, dapat di-revoke.
- `DeviceTrust` — ledger perangkat tepercaya per pengguna (unique `[user_id, device_id]`).

**Programs**
- `OPRCProgram` — unit tenancy. `code` unik, `level` 1–3.
- `ProgramEnrollment` (User × Program, unique) — skor pretest/posttest, attendance_pct, cert_eligible.
- `ProgramTrainer` (User × Program, unique) — penugasan trainer.
- `ParticipantLoginQR` (User × Program, unique) — token QR login.

**Learning Content**
- `Course` → `Module` → `Lesson` (hierarki via `order_index`).
- `Video` (1–1 Lesson) — `VideoWatchSession`, `VideoBookmark`.
- `LessonProgress` (User × Lesson × Program, unique).
- `Quiz` (1–1 Lesson) → `QuizQuestion`, `QuizAttempt`.

**Assessment**
- `CourseTest` (Program × TestType, unique) → `Question`, `TestAttempt`.

**Sessions & Attendance**
- `Session` → `QRToken`, `Attendance`, `SessionRSVP`.
- `Attendance` (Session × User, unique) — geo + flag.

**Certification**
- `Certificate` (1–1 Enrollment) — `cert_no` & `verification_code` unik.

**AI / KB**
- `KnowledgeBaseDoc` → `KnowledgeBaseChunk` (embedding `vector(768)`).
- `AIConversation` → `AIMessage` (sources, feedback).

**Audit**
- `AuditLog`, `EmailLog`.

> Skema sumber kebenaran: `osct_backend/prisma/schema.prisma` (691 baris).

---

## 8. API Surface

Base path: `/api/v1`. 14 modul route. Resource per-program memakai middleware `verifyJWT` + `programIsolation`.

| Modul | Endpoint Utama |
|---|---|
| `/auth` | login, qr-login, refresh, logout, forgot-password, reset-password, devices (GET/confirm/DELETE) |
| `/programs` | list, `:pid`, CRUD, enrollments, batch-enroll, trainers, trainer/assignments (pending/acknowledge) |
| `/courses` | `programs/:pid`, `programs/:pid/:id`, create/update, modules/lessons |
| `/videos` | `programs/:pid`, upload, `:id`, watch-session, bookmarks |
| `/tests` | `programs/:pid/:kind`, attempts, submit, grading, questions CRUD |
| `/quizzes` | `lessons/:lessonId`, submit, attempts, questions CRUD |
| `/sessions` | list/CRUD, `:id/qr` (start/stop), `:id/rsvp` (GET/POST), recurring |
| `/attendance` | `scan` |
| `/certificates` | eligibility, generate, send, `mine` |
| `/ai` | `programs/:pid/chat`, conversations, messages/:id/feedback |
| `/kb` | `programs/:pid` (list/upload/delete), embed |
| `/users` | list, `me`, create/update/delete |
| `/reports` | participants, courses, attendance — masing-masing + `.csv` / `.pdf` |
| `/emails` | send, broadcast, logs, `cron/session-reminders` |
| `/` (publicCert) | `claim`, `verify/:certNo` — **publik, tanpa auth** |

---

## 9. Business Rules Penting

Aturan yang sudah diputuskan dan **tidak perlu diperdebatkan ulang**:

1. **Program isolation mutlak** — tidak ada endpoint datar yang melewati `programIsolation`.
2. **Satu pretest + satu posttest per program** — dijamin unique `[program_id, type]`.
3. **`max_attempts` default** — PRETEST 1, POSTTEST 2; dapat di-override admin.
4. **Konflik jadwal sesi = peringatan lunak**, tidak pernah memblokir simpan.
5. **Sesi tanpa `duration_min`** diasumsikan 60 menit.
6. **Recurring session** berbagi satu `series_id`; `DELETE ?series=true` menghapus seluruh seri.
7. **RSVP** — kapasitas hanya memblokir `GOING` baru ketika sudah penuh.
8. **Reminder sesi in-app** diturunkan dari data `upcomingSessions` — tanpa endpoint khusus.
9. **Reminder email H-1** harian via cron; `reminder_sent_at` mencegah kirim ganda.
10. **Presensi di luar geo-fence tetap dicatat**, hanya diberi `is_flagged`.
11. **MCQ auto-grade; esai dinilai trainer** — skor final disalin ke enrollment.
12. **Tidak ada data fiktif** — panel tanpa data pendukung dihapus, bukan diisi angka palsu/proxy.
13. **Resend test mode** — email hanya sampai ke pemilik akun sampai domain diverifikasi.
14. **Migrasi DB** dijalankan lokal (`prisma migrate deploy`), tidak pernah saat runtime Vercel.
15. **Kelayakan sertifikat** = `attendance_pct ≥ 80%` **DAN** `posttest_score ≥ 70`. Kedua ambang adalah konstanta backend.
16. **Posttest terkunci** sampai seluruh lesson program selesai (`isProgramLearningComplete`).
17. **Kehadiran** dihitung terhadap sesi yang `scheduled_at`-nya sudah lewat; di-recompute setiap scan presensi.

---

## 10. Non-Functional Requirements

| Aspek | Requirement |
|---|---|
| **Keamanan** | Password bcrypt; JWT access + refresh; device trust untuk login QR; audit log; isolasi program di middleware. |
| **Performa** | Query per-program ber-index; pencarian KB via index pgvector; pooler Supabase untuk koneksi runtime. |
| **Skalabilitas** | Backend serverless (stateless); storage file di Supabase Storage, bukan di server. |
| **Ketersediaan** | Hosting Vercel; cron harian (kompatibel Vercel Hobby). |
| **Usability** | Bilingual ID/EN di UI; tema per-program; **mobile responsive (sedang dikerjakan)**. |
| **Auditability** | Audit log + email log untuk aksi penting. |
| **Maintainability** | Konvensi penomoran FR; pola route konsisten; skema Prisma sebagai sumber kebenaran. |
| **Kompatibilitas** | Target: browser modern desktop & mobile. |

---

## 11. Roadmap & Backlog

### 11.1 Baru Selesai

**FR-18 — Mobile Responsive Pass** ✅ Shipped *(merged ke `main` 2026-05-21)*
- Sidebar menjadi *off-canvas drawer* dengan tombol hamburger.
- Grid runtuh ke 1 kolom, modal jadi fluid, tabel lebar dibungkus `TableWrap` agar bisa scroll horizontal.
- Kalender sesi → tampilan agenda di mobile; AI chat menyembunyikan panel riwayat.
- `TestScreens.jsx` — navigator soal mempertahankan grid 5 kolom di mobile; hero hasil tes *wrap* + lebar fluid.

> Tidak ada pekerjaan lain yang sedang berjalan saat ini.

### 11.2 Backlog Usulan (Belum Dijadwalkan)

**Prioritas Tinggi** *(dikonfirmasi pemilik produk, 21 Mei 2026)*
- **FR-19 — Notifikasi fungsional** — ikon lonceng saat ini non-fungsional; perlu pusat notifikasi nyata (tes, sesi, sertifikat, penugasan).
- **FR-20 — Verifikasi domain email** — agar email menjangkau seluruh peserta, bukan hanya pemilik akun Resend. Saat ini bersifat *blocker* bagi seluruh notifikasi email.
- **FR-23 — Pelaporan kepatuhan IMO** — laporan terstandardisasi sesuai format regulator; menambah nilai jual & kredibilitas untuk lembaga pelatihan.

**Prioritas Menengah**
- **FR-21 — Pencarian global** — kolom pencarian di topnav belum fungsional (dan disembunyikan di mobile).
- **FR-22 — Manajemen kuota kursus** — `Course.quota` sudah ada di skema tetapi belum diberdayakan penuh.
- **FR-24 — Bulk certificate operations** — terbitkan/kirim sertifikat satu batch sekaligus.
- **FR-25 — Reminder pretest/posttest terjadwal** — perluasan pola cron sesi ke asesmen.

**Prioritas Rendah / Eksplorasi**
- **FR-26 — Analitik feedback AI** — manfaatkan data thumbs up/down untuk perbaikan KB.
- **FR-27 — Penjadwalan ekspor laporan** — kirim laporan berkala via email otomatis.
- **FR-28 — Tema/branding white-label per lembaga** — relevan bila produk dilisensikan ke banyak lembaga.
- **FR-29 — Optimasi bundle frontend** — bundle saat ini ~1,37 MB; pertimbangkan code-splitting.

### 11.3 Utang Teknis

- `Course.is_published` (boolean legacy) perlu dihapus setelah semua pembaca beralih ke `Course.status`.
- Bundle JS frontend > 500 KB — kandidat *manual chunking* / *dynamic import*.
- `react-hot-toast` di-import secara statis sekaligus dinamis — konsolidasikan.
- `@anthropic-ai/sdk` + `src/config/claude.js` adalah kode mati — `claude.js` tidak diimpor di mana pun; layanan AI sepenuhnya memakai Gemini. Hapus dependency & file ini.

---

## 12. Lampiran

### 12.1 Environment Variables (Backend)

| Variabel | Fungsi |
|---|---|
| `DATABASE_URL` | Koneksi Postgres runtime (pooler Supabase, port 6543) |
| `DIRECT_URL` | Koneksi langsung untuk migrasi (port 5432) |
| `JWT_SECRET` | Tanda tangan access token |
| `JWT_QR_SECRET` | Tanda tangan token QR login (berlaku 365 hari) |
| `CRON_SECRET` | Otorisasi endpoint cron reminder sesi |
| `RESEND_API_KEY` | Pengiriman email |
| `GEMINI_API_KEY` | Chat AI + embedding |
| Kredensial Supabase Storage | Akses bucket `videos`, `kb-docs` |

### 12.2 Glosarium

| Istilah | Arti |
|---|---|
| **OPRC** | Oil Pollution Preparedness, Response and Co-operation — konvensi IMO |
| **OSCT** | Oil Spill Combat Training — nama platform |
| **Program** | Satu jenjang pelatihan OPRC (Level 1/2/3); unit tenancy/isolasi |
| **Enrollment** | Pendaftaran peserta ke sebuah program |
| **Learning Gain** | Selisih skor posttest − pretest |
| **Geo-fence** | Batas radius lokasi untuk validasi presensi |
| **RAG** | Retrieval-Augmented Generation — AI menjawab dari dokumen KB |
| **Training Mode** | INHOUSE (cohort 1 perusahaan) vs PUBLIC (campuran) |

### 12.3 Cara Memakai PRD Ini untuk Pengembangan

1. **Fitur baru** → beri nomor FR berikutnya (lanjut dari FR-18), tulis acceptance criteria sebelum mulai koding.
2. **Resource per-program baru** → wajib ikut pola Program Isolation (Bagian 5).
3. **Perubahan skema** → ubah `schema.prisma`, jalankan `prisma migrate dev` lokal lalu `migrate deploy`, regenerasi client, redeploy.
4. **Setiap FR yang selesai** → tandai ✅ Shipped dan perbarui dokumen ini.
5. PRD ini adalah *living document* — jaga agar sinkron dengan kode.

---

*Dokumen di-generate dari analisis kode produksi OSCT — `osct_backend` & `osct_frontend` — per 21 Mei 2026.*
