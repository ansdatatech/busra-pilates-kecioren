import type { APIRoute } from 'astro';
import { db } from '../../db';
import { rezervasyonlar, musteriler, kapaliGunler, egitmenler, iptalKayitlari } from '../../db/schema';
import { eq, and, gte, asc } from 'drizzle-orm'; 
import { jwtVerify } from 'jose';

export const prerender = false;

const GRUP_KAPASITE = 4;
const JWT_SECRET = new TextEncoder().encode(import.meta.env.JWT_SECRET || 'gizli_anahtar_degistir_lutfen');

const GUN_ADLARI: Record<number, string> = {
    0: 'Pazar',
    1: 'Pazartesi',
    2: 'Salı',
    3: 'Çarşamba',
    4: 'Perşembe',
    5: 'Cuma',
    6: 'Cumartesi'
};

interface EgitmenKaydi {
    id: number;
    adSoyad: string;
    anahtar: string;
    baslangicSaati: number;
    bitisSaati: number;
    renk: string;
    aktif: boolean;
}

async function kimlikGetir(cookies: any) {
    try {
        const token = cookies.get('auth_token')?.value;
        if (!token) return null;
        const { payload } = await jwtVerify(token, JWT_SECRET);
        return { rol: payload.rol as string, kullaniciAdi: payload.kullaniciAdi as string };
    } catch (e) {
        return null;
    }
}

function kayitFormatiniCozumle(dersFormati?: string | null, rezervasyonTuru: string = ''): 'grup' | 'ozel' {
    if (dersFormati === 'ozel' || dersFormati === 'grup') return dersFormati;
    const t = (rezervasyonTuru || '').toLocaleLowerCase('tr-TR');
    if (t.includes('özel') || t.includes('ozel')) return 'ozel';
    return 'grup';
}

function isGrupDers(dersFormati?: string | null, rezervasyonTuru: string = ''): boolean {
    return kayitFormatiniCozumle(dersFormati, rezervasyonTuru) === 'grup';
}

function tarihEkle(baslangicTarihi: string, eklenecekGun: number): string {
    const [yil, ay, gun] = baslangicTarihi.split('-').map(Number);
    const tarih = new Date(yil, ay - 1, gun);
    tarih.setDate(tarih.getDate() + eklenecekGun);
    const y = tarih.getFullYear();
    const m = String(tarih.getMonth() + 1).padStart(2, '0');
    const d = String(tarih.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function tarihTrFormat(tarihStr: string): string {
    const [y, m, d] = tarihStr.split('-');
    return `${d}.${m}.${y}`;
}

function gunIndexBul(tarihStr: string): number {
    const [yil, ay, gun] = tarihStr.split('-').map(Number);
    return new Date(yil, ay - 1, gun).getDay();
}

function saatDakikaToDk(saatStr: string): number {
    const [s, d = '0'] = (saatStr || '00:00').split(':');
    return (parseInt(s, 10) || 0) * 60 + (parseInt(d, 10) || 0);
}

function bugunYerelTarihStr(): string {
    const simdi = new Date();
    const yil = simdi.getFullYear();
    const ay = String(simdi.getMonth() + 1).padStart(2, '0');
    const gun = String(simdi.getDate()).padStart(2, '0');
    return `${yil}-${ay}-${gun}`;
}

function bugunGecmisSaatMi(tarihStr: string, saatStr: string): boolean {
    const bugunTarihi = bugunYerelTarihStr();
    if (tarihStr !== bugunTarihi) return false;

    const simdi = new Date();
    const suAnkiDk = simdi.getHours() * 60 + simdi.getMinutes();
    const slotDk = saatDakikaToDk(saatStr);
    return slotDk < suAnkiDk;
}

function egitmenMesaiDisindaMi(egitmen: EgitmenKaydi | undefined, saatStr: string): boolean {
    if (!egitmen) return false;
    const saatInt = parseInt((saatStr || '00:00').split(':')[0], 10);
    const basSaat = parseInt(String(egitmen.baslangicSaati ?? 9), 10);
    const bitSaat = parseInt(String(egitmen.bitisSaati ?? 22), 10);
    return isNaN(saatInt) || saatInt < basSaat || saatInt >= bitSaat;
}

async function aktifEgitmenleriGetir(): Promise<EgitmenKaydi[]> {
    let liste = await db.select().from(egitmenler).orderBy(asc(egitmenler.id));
    if (liste.length === 0) {
        await db.insert(egitmenler).values([
            { adSoyad: 'İlayda Hoca', anahtar: 'ilayda', baslangicSaati: 9, bitisSaati: 17, renk: '#6B4C63', aktif: true },
            { adSoyad: 'Esra Hoca', anahtar: 'esra', baslangicSaati: 15, bitisSaati: 22, renk: '#9E6B8E', aktif: true },
            { adSoyad: 'Büşra Hoca', anahtar: 'busra', baslangicSaati: 17, bitisSaati: 22, renk: '#E563B1', aktif: true },
        ]);
        liste = await db.select().from(egitmenler).orderBy(asc(egitmenler.id));
    }
    return liste.filter(e => e.aktif);
}

function egitmenVeKortCozumle(aktifListe: EgitmenKaydi[], kortNo: number, gelenUzman?: string) {
    const indexTabanli = aktifListe[kortNo - 1] || aktifListe[0];
    let secilen = aktifListe.find(e => e.anahtar === gelenUzman) || indexTabanli;
    const cozumlenenKort = secilen
        ? (aktifListe.findIndex(e => e.anahtar === secilen.anahtar) + 1)
        : (kortNo || 1);

    return {
        uzmanKey: secilen ? secilen.anahtar : (gelenUzman || 'ilayda'),
        kortNo: cozumlenenKort > 0 ? cozumlenenKort : (kortNo || 1),
        egitmen: secilen
    };
}

function izinSebebiBul(
    tumIzinler: Array<{ tip: string; deger: string; kapsam: string; sebep: string }>,
    tarihStr: string,
    saatStr: string,
    gIndex: number,
    uzmanKey: string,
    kortNo: number
): string | null {
    if (gIndex === 0) return 'Pazar günü stüdyo kapalı';
    const slotDk = saatDakikaToDk(saatStr);

    const eslesen = tumIzinler.find(iz => {
        const kapsamUyuyor =
            iz.kapsam === 'TUM' ||
            iz.kapsam === uzmanKey ||
            iz.kapsam === String(kortNo);
        if (!kapsamUyuyor) return false;

        if (iz.tip === 'tarih' && iz.deger === tarihStr) return true;
        if (iz.tip === 'rutin' && parseInt(iz.deger, 10) === gIndex) return true;
        if (iz.tip === 'aralik') {
            const [bas, bit] = iz.deger.split('_');
            if (tarihStr >= bas && tarihStr <= bit) return true;
        }
        if (iz.tip === 'saatlik') {
            const [izinTarih, sBas, sBit] = iz.deger.split('_');
            if (izinTarih === tarihStr) {
                const basDk = saatDakikaToDk(sBas);
                const bitDk = saatDakikaToDk(sBit);
                if (slotDk >= basDk && slotDk < bitDk) return true;
            }
        }
        return false;
    });

    if (!eslesen) return null;
    return eslesen.sebep ? `İzinli / Kapalı (${eslesen.sebep})` : 'Eğitmen veya stüdyo izinli / kapalı';
}

function izinKapaliMi(
    tumIzinler: Array<{ tip: string; deger: string; kapsam: string; sebep: string }>,
    tarihStr: string,
    saatStr: string,
    gIndex: number,
    uzmanKey: string,
    kortNo: number
): boolean {
    return izinSebebiBul(tumIzinler, tarihStr, saatStr, gIndex, uzmanKey, kortNo) !== null;
}

// 1. VERİ GETİRME (GET)
export const GET: APIRoute = async ({ request, cookies }) => {
    const token = cookies.get('auth_token')?.value;
    if (!token) return new Response(JSON.stringify({ error: "Yetkisiz erişim!" }), { status: 401 });
    try {
        await jwtVerify(token, JWT_SECRET);
    } catch (error) {
        return new Response(JSON.stringify({ error: "Geçersiz veya süresi dolmuş oturum!" }), { status: 403 });
    }

    try {
        const url = new URL(request.url);
        const istenenTarih = url.searchParams.get('tarih');
        if (!istenenTarih) return new Response(JSON.stringify({ error: "Tarih eksik!" }), { status: 400 });

        const [kayitlar, tumMusteriler] = await Promise.all([
            istenenTarih === 'hepsi'
                ? db.select().from(rezervasyonlar)
                : db.select().from(rezervasyonlar).where(eq(rezervasyonlar.tarih, istenenTarih)),
            db.select().from(musteriler)
        ]);

        const idHaritasi = new Map<number, { id: number; kalan: number; notlar: string }>();
        const isimHaritasi = new Map<string, { id: number; kalan: number; notlar: string }>();

        tumMusteriler.forEach((m: any) => {
            const bilgi = {
                id: Number(m.id),
                kalan: Number(m.kalanDers ?? 0),
                notlar: (m.notlar || '').trim()
            };
            if (typeof m.id === 'number') idHaritasi.set(m.id, bilgi);
            if (m.adSoyad) isimHaritasi.set(m.adSoyad.trim().toLocaleLowerCase('tr-TR'), bilgi);
        });

        const zenginKayitlar = kayitlar.map((k: any) => {
            let eslesen = null;
            if (k.musteriId && idHaritasi.has(Number(k.musteriId))) {
                eslesen = idHaritasi.get(Number(k.musteriId)) || null;
            } else if (k.kisiAdi) {
                const anahtar = String(k.kisiAdi).trim().toLocaleLowerCase('tr-TR');
                if (isimHaritasi.has(anahtar)) {
                    eslesen = isimHaritasi.get(anahtar) || null;
                }
            }
            return {
                ...k,
                musteriId: k.musteriId || eslesen?.id || null,
                kalanDers: eslesen ? eslesen.kalan : null,
                musteriNotu: eslesen?.notlar || ''
            };
        });

        return new Response(JSON.stringify(zenginKayitlar), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
};

// 2. KAYIT EKLEME (POST) - Katı Ön Doğrulama + Mevcut Bakiye Üzerine Paket Ekleme
export const POST: APIRoute = async ({ request, cookies }) => {
    const kimlik = await kimlikGetir(cookies);
    if (!kimlik) return new Response(JSON.stringify({ error: "Oturum süresi dolmuş." }), { status: 401 });

    try {
        const body = await request.json();
        const hamKortNo = parseInt(body.kortNo, 10) || 1;
        const paketSayisi = Math.max(1, parseInt(body.paketSayisi, 10) || 1);
        const dersFormati = kayitFormatiniCozumle(body.dersFormati, body.rezervasyonTuru);
        const grupMu = dersFormati === 'grup';

        const hamUyeler = Array.isArray(body.uyeler) && body.uyeler.length > 0
            ? body.uyeler
            : [{
                kisiAdi: body.kisiAdi,
                telefon: body.telefon,
                cinsiyet: body.cinsiyet || 'kadin'
            }];

        const temizUyeler = hamUyeler
            .map((u: any) => ({
                kisiAdi: (u.kisiAdi || '').trim(),
                telefon: (u.telefon || '').trim(),
                cinsiyet: u.cinsiyet || 'kadin'
            }))
            .filter((u: any) => u.kisiAdi.length > 0);

        if (temizUyeler.length === 0) {
            return new Response(JSON.stringify({ error: "En az bir üye adı giriniz." }), { status: 400 });
        }

        if (!grupMu && temizUyeler.length > 1) {
            return new Response(JSON.stringify({ error: "Özel derslerde yalnızca 1 üye kaydedilebilir." }), { status: 400 });
        }

        if (grupMu && temizUyeler.length > GRUP_KAPASITE) {
            return new Response(JSON.stringify({ error: `Grup dersi en fazla ${GRUP_KAPASITE} kişi alabilir.` }), { status: 400 });
        }

        const aktifEgitmenler = await aktifEgitmenleriGetir();
        const { uzmanKey, kortNo, egitmen: secilenEgitmen } = egitmenVeKortCozumle(aktifEgitmenler, hamKortNo, body.ekleyen);

        if (egitmenMesaiDisindaMi(secilenEgitmen, body.saat)) {
            return new Response(JSON.stringify({ error: "Seçilen saat eğitmenin çalışma saatleri dışındadır!" }), { status: 400 });
        }

        const bugunTarihi = bugunYerelTarihStr();

        if (body.tarih < bugunTarihi && kimlik.rol !== 'yonetici') {
            return new Response(JSON.stringify({ error: "Geçmiş tarihlere yeni ders eklenemez!" }), { status: 400 });
        }

        if (bugunGecmisSaatMi(body.tarih, body.saat)) {
            return new Response(JSON.stringify({ error: "Bugün için geçmiş bir saate yeni ders eklenemez!" }), { status: 400 });
        }

        const tumIzinler = await db.select().from(kapaliGunler);
        const baslangicGunIdx = gunIndexBul(body.tarih);

        const secilenGunler: number[] = (Array.isArray(body.secilenGunler) && body.secilenGunler.length > 0)
            ? body.secilenGunler.map(Number)
            : [baslangicGunIdx];

        // AŞAMA 1: Hedeflenen tüm günleri belirle ve veritabanına yazmadan önce tek tek doğrula
        const hedeflenenTarihler: string[] = [];
        let gunOffset = 0;
        const maxTaramaGunu = paketSayisi === 1 ? 1 : 365;

        while (hedeflenenTarihler.length < paketSayisi && gunOffset < maxTaramaGunu) {
            const adayTarih = tarihEkle(body.tarih, gunOffset);
            const gIndex = gunIndexBul(adayTarih);
            gunOffset++;

            if (paketSayisi === 1 || secilenGunler.includes(gIndex)) {
                hedeflenenTarihler.push(adayTarih);
            }
        }

        if (hedeflenenTarihler.length < paketSayisi) {
            return new Response(JSON.stringify({
                error: "Seçilen günlere göre paket tarihleri oluşturulamadı."
            }), { status: 400 });
        }

        const cakismaListesi: string[] = [];

        for (const kontrolTarihi of hedeflenenTarihler) {
            const gIndex = gunIndexBul(kontrolTarihi);
            const gunAdi = GUN_ADLARI[gIndex] || '';
            const tarihEtiketi = `${tarihTrFormat(kontrolTarihi)} ${gunAdi} (${body.saat})`;

            const izinSebep = izinSebebiBul(tumIzinler, kontrolTarihi, body.saat, gIndex, uzmanKey, kortNo);
            if (izinSebep) {
                cakismaListesi.push(`${tarihEtiketi}: ${izinSebep}`);
                continue;
            }

            const mevcutKayitlar = await db.select().from(rezervasyonlar).where(
                and(
                    eq(rezervasyonlar.tarih, kontrolTarihi),
                    eq(rezervasyonlar.saat, body.saat),
                    eq(rezervasyonlar.alanId, kortNo)
                )
            );

            if (grupMu) {
                const ozelKayit = mevcutKayitlar.find(k => !isGrupDers(k.dersFormati, k.rezervasyonTuru || ''));
                if (ozelKayit) {
                    cakismaListesi.push(`${tarihEtiketi}: Özel ders kaydı var (${ozelKayit.kisiAdi})`);
                    continue;
                }

                const cakisanUyeler = temizUyeler.filter(u =>
                    mevcutKayitlar.some(k => k.kisiAdi.toLocaleLowerCase('tr-TR') === u.kisiAdi.toLocaleLowerCase('tr-TR'))
                );
                if (cakisanUyeler.length > 0) {
                    cakismaListesi.push(`${tarihEtiketi}: ${cakisanUyeler.map(u => u.kisiAdi).join(', ')} bu derste zaten kayıtlı`);
                    continue;
                }

                if (mevcutKayitlar.length + temizUyeler.length > GRUP_KAPASITE) {
                    const kalan = Math.max(0, GRUP_KAPASITE - mevcutKayitlar.length);
                    cakismaListesi.push(`${tarihEtiketi}: Grup kontenjanı yetersiz (Mevcut: ${mevcutKayitlar.length}/${GRUP_KAPASITE}, Kalan yer: ${kalan})`);
                    continue;
                }
            } else if (mevcutKayitlar.length > 0) {
                const mevcutIsimler = mevcutKayitlar.map(k => k.kisiAdi).join(', ');
                cakismaListesi.push(`${tarihEtiketi}: Eğitmen dolu (${mevcutIsimler})`);
            }
        }

        // Herhangi bir günde çakışma/izin varsa HİÇ KAYIT YAPMADAN detaylı hata dön
        if (cakismaListesi.length > 0) {
            return new Response(JSON.stringify({
                error: "Seçilen programda çakışan veya kapalı günler bulunduğu için kayıt yapılmadı.",
                cakismalar: cakismaListesi
            }), { status: 400 });
        }

        // AŞAMA 2: Tüm tarihler uygun, veritabanına yaz
        let toplamBasariliDers = 0;
        const uyeOzetleri: Array<{ kisiAdi: string; eklenen: number }> = [];

        for (const uye of temizUyeler) {
            let musteriId: number | null = null;
            let mevcutMusteri: any = null;
            let yeniOlusturulduMu = false;

            if (uye.telefon) {
                const bulunan = await db.select().from(musteriler).where(eq(musteriler.telefon, uye.telefon)).limit(1);
                if (bulunan.length > 0) {
                    mevcutMusteri = bulunan[0];
                    musteriId = mevcutMusteri.id;
                }
            }
            if (!mevcutMusteri) {
                const isimleBulunan = await db.select().from(musteriler).where(eq(musteriler.adSoyad, uye.kisiAdi)).limit(1);
                if (isimleBulunan.length > 0) {
                    mevcutMusteri = isimleBulunan[0];
                    musteriId = mevcutMusteri.id;
                } else {
                    const [yeniMusteri] = await db.insert(musteriler).values({
                        adSoyad: uye.kisiAdi,
                        telefon: uye.telefon || '',
                        cinsiyet: uye.cinsiyet,
                        toplamDers: paketSayisi > 1 ? paketSayisi : 0,
                        kalanDers: paketSayisi > 1 ? paketSayisi : 0
                    }).returning();
                    mevcutMusteri = yeniMusteri;
                    musteriId = yeniMusteri.id;
                    yeniOlusturulduMu = true;
                }
            }

            const seriId = paketSayisi > 1 ? `pkt_${Date.now()}_${musteriId || Math.floor(Math.random() * 1000)}` : null;

            for (const islenecekTarih of hedeflenenTarihler) {
                await db.insert(rezervasyonlar).values({
                    alanId: kortNo,
                    tarih: islenecekTarih,
                    saat: body.saat,
                    kisiAdi: uye.kisiAdi,
                    telefon: uye.telefon,
                    rezervasyonTuru: body.rezervasyonTuru,
                    dersFormati,
                    cinsiyet: uye.cinsiyet,
                    notlar: uzmanKey,
                    onayDurumu: 'onaylandi',
                    seriId: seriId,
                    musteriId: musteriId
                });
                toplamBasariliDers++;
            }

            if (mevcutMusteri && musteriId && !yeniOlusturulduMu) {
                if (paketSayisi > 1) {
                    await db.update(musteriler).set({
                        toplamDers: (mevcutMusteri.toplamDers || 0) + paketSayisi,
                        kalanDers: (mevcutMusteri.kalanDers || 0) + paketSayisi
                    }).where(eq(musteriler.id, musteriId));
                } else if ((mevcutMusteri.kalanDers || 0) > 0) {
                    await db.update(musteriler).set({
                        kalanDers: Math.max(0, (mevcutMusteri.kalanDers || 0) - 1)
                    }).where(eq(musteriler.id, musteriId));
                }
            }

            uyeOzetleri.push({ kisiAdi: uye.kisiAdi, eklenen: hedeflenenTarihler.length });
        }

        return new Response(JSON.stringify({
            success: true,
            basariliKayit: toplamBasariliDers,
            atlananKayit: 0,
            dersFormati,
            uyeSayisi: temizUyeler.length,
            uyeOzetleri,
            ilkTarih: hedeflenenTarihler[0] || body.tarih,
            sonTarih: hedeflenenTarihler[hedeflenenTarihler.length - 1] || body.tarih
        }), { status: 200 });

    } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
};

// 3. AKILLI KAYIT DÜZENLEME & TAŞIMA (PUT)
export const PUT: APIRoute = async ({ request, cookies }) => {
    const kimlik = await kimlikGetir(cookies);
    if (!kimlik) return new Response(JSON.stringify({ error: "Oturum süresi dolmuş." }), { status: 401 });

    try {
        const body = await request.json();
        const kayitId = parseInt(body.id, 10);
        const guncellenecek = await db.select().from(rezervasyonlar).where(eq(rezervasyonlar.id, kayitId)).limit(1);
        if (guncellenecek.length === 0) return new Response(JSON.stringify({ error: "Kayıt bulunamadı!" }), { status: 404 });

        const eski = guncellenecek[0];
        if ((kimlik.rol === 'egitmen' || kimlik.rol === 'uzman') && eski.notlar !== kimlik.kullaniciAdi) {
            return new Response(JSON.stringify({ error: "Sadece kendi derslerinizi düzenleyebilirsiniz!" }), { status: 403 });
        }

        const aktifEgitmenler = await aktifEgitmenleriGetir();
        const yeniTarih = body.tarih || eski.tarih;
        const yeniSaat = body.saat || eski.saat;
        const { uzmanKey: yeniUzman, kortNo: yeniKortNo, egitmen: hedefEgitmen } = egitmenVeKortCozumle(
            aktifEgitmenler,
            eski.alanId || 1,
            body.ekleyen || eski.notlar || undefined
        );
        const yeniTur = body.rezervasyonTuru || eski.rezervasyonTuru || '';
        const yeniFormat = kayitFormatiniCozumle(body.dersFormati ?? eski.dersFormati, yeniTur);
        const grupMu = yeniFormat === 'grup';

        const yerDegisti = (yeniTarih !== eski.tarih || yeniSaat !== eski.saat || yeniKortNo !== eski.alanId);

        if (yerDegisti) {
            if (bugunGecmisSaatMi(yeniTarih, yeniSaat)) {
                return new Response(JSON.stringify({ error: "Bugün için geçmiş bir saate ders taşınamaz!" }), { status: 400 });
            }

            if (egitmenMesaiDisindaMi(hedefEgitmen, yeniSaat)) {
                const basSaat = String(hedefEgitmen?.baslangicSaati ?? 9).padStart(2, '0');
                const bitSaat = String(hedefEgitmen?.bitisSaati ?? 22).padStart(2, '0');
                return new Response(JSON.stringify({
                    error: `${hedefEgitmen?.adSoyad || 'Eğitmen'} için seçilen saat (${yeniSaat}) çalışma saatleri (${basSaat}:00 - ${bitSaat}:00) dışındadır!`
                }), { status: 400 });
            }

            const gIndex = gunIndexBul(yeniTarih);
            const tumIzinler = await db.select().from(kapaliGunler);
            const izinSebep = izinSebebiBul(tumIzinler, yeniTarih, yeniSaat, gIndex, yeniUzman, yeniKortNo);
            if (izinSebep) {
                return new Response(JSON.stringify({ error: `Hedef tarih/saat uygun değil: ${izinSebep}` }), { status: 400 });
            }

            const hedefKayitlar = (await db.select().from(rezervasyonlar).where(
                and(
                    eq(rezervasyonlar.tarih, yeniTarih),
                    eq(rezervasyonlar.saat, yeniSaat),
                    eq(rezervasyonlar.alanId, yeniKortNo)
                )
            )).filter(k => k.id !== kayitId);

            if (grupMu) {
                const ozelVar = hedefKayitlar.some(k => !isGrupDers(k.dersFormati, k.rezervasyonTuru || ''));
                const ayniUyeVar = hedefKayitlar.some(k => k.kisiAdi.toLocaleLowerCase('tr-TR') === (body.kisiAdi || eski.kisiAdi).toLocaleLowerCase('tr-TR'));
                if (ozelVar || ayniUyeVar || hedefKayitlar.length >= GRUP_KAPASITE) {
                    return new Response(JSON.stringify({ error: `Hedef saat dolu (Max ${GRUP_KAPASITE} kişi), özel ders var veya üye zaten orada kayıtlı!` }), { status: 400 });
                }
            } else {
                if (hedefKayitlar.length > 0) {
                    return new Response(JSON.stringify({ error: "Hedef saatte bu eğitmen zaten dolu!" }), { status: 400 });
                }
            }
        }

        await db.update(rezervasyonlar).set({
            tarih: yeniTarih,
            saat: yeniSaat,
            alanId: yeniKortNo,
            kisiAdi: body.kisiAdi, 
            telefon: body.telefon, 
            rezervasyonTuru: yeniTur,
            dersFormati: yeniFormat,
            cinsiyet: body.cinsiyet || 'kadin',
            notlar: yeniUzman,
            onayDurumu: body.onayDurumu || eski.onayDurumu
        }).where(eq(rezervasyonlar.id, kayitId));

        return new Response(JSON.stringify({ success: true }), { status: 200 });
    } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
};

// 4. AKILLI KAYIT SİLME (DELETE) - Tek / Seri + Kredi Senkronizasyonu + İptal Logu
export const DELETE: APIRoute = async ({ request, cookies }) => {
    const kimlik = await kimlikGetir(cookies);
    if (!kimlik) return new Response(JSON.stringify({ error: "Oturum süresi dolmuş." }), { status: 401 });

    try {
        const url = new URL(request.url);
        const id = url.searchParams.get('id');
        const kapsam = url.searchParams.get('kapsam') || 'tek';
        const hakIade = url.searchParams.get('hakIade') || 'hayir';

        if (!id) return new Response(JSON.stringify({ error: "ID eksik!" }), { status: 400 });

        const silinecekKayit = await db.select().from(rezervasyonlar).where(eq(rezervasyonlar.id, parseInt(id, 10))).limit(1);
        if (silinecekKayit.length === 0) return new Response(JSON.stringify({ success: true }), { status: 200 });
        const k = silinecekKayit[0];

        if ((kimlik.rol === 'egitmen' || kimlik.rol === 'uzman') && k.notlar !== kimlik.kullaniciAdi) {
            return new Response(JSON.stringify({ error: "Sadece kendi derslerinizi silebilirsiniz!" }), { status: 403 });
        }

        let telafiTarih: string | null = null;
        let silinenAdet = 0;

        if (kapsam === 'seri' && k.seriId) {
            const silinenler = await db.delete(rezervasyonlar).where(
                and(
                    eq(rezervasyonlar.seriId, k.seriId),
                    gte(rezervasyonlar.tarih, k.tarih)
                )
            ).returning();

            silinenAdet = silinenler.length;

            if (silinenAdet > 0) {
                await db.insert(iptalKayitlari).values(
                    silinenler.map((s) => ({
                        musteriId: s.musteriId,
                        kisiAdi: s.kisiAdi,
                        telefon: s.telefon,
                        tarih: s.tarih,
                        saat: s.saat,
                        rezervasyonTuru: s.rezervasyonTuru,
                        dersFormati: kayitFormatiniCozumle(s.dersFormati, s.rezervasyonTuru || ''),
                        egitmen: s.notlar,
                        islemTuru: 'seri_iptal',
                        telafiTarih: null,
                        iptalEden: kimlik.kullaniciAdi
                    }))
                );

                const hedefMusteri = k.musteriId
                    ? await db.select().from(musteriler).where(eq(musteriler.id, k.musteriId)).limit(1)
                    : await db.select().from(musteriler).where(eq(musteriler.adSoyad, k.kisiAdi)).limit(1);

                if (hedefMusteri.length > 0) {
                    await db.update(musteriler)
                        .set({ kalanDers: Math.max(0, (hedefMusteri[0].kalanDers || 0) - silinenAdet) })
                        .where(eq(musteriler.id, hedefMusteri[0].id));
                }
            }
        } else {
            await db.delete(rezervasyonlar).where(eq(rezervasyonlar.id, k.id));
            silinenAdet = 1;

            if (hakIade === 'evet') {
                const hedefMusteri = k.musteriId
                    ? await db.select().from(musteriler).where(eq(musteriler.id, k.musteriId)).limit(1)
                    : await db.select().from(musteriler).where(eq(musteriler.adSoyad, k.kisiAdi)).limit(1);

                if (hedefMusteri.length > 0) {
                    await db.update(musteriler)
                        .set({ kalanDers: (hedefMusteri[0].kalanDers || 0) + 1 })
                        .where(eq(musteriler.id, hedefMusteri[0].id));
                }
            }

            if (hakIade === 'telafi' && k.seriId) {
                const seriDersleri = await db.select().from(rezervasyonlar).where(eq(rezervasyonlar.seriId, k.seriId));
                const gunlerSet = new Set<number>([gunIndexBul(k.tarih)]);
                let sonTarih = k.tarih;

                seriDersleri.forEach(d => {
                    gunlerSet.add(gunIndexBul(d.tarih));
                    if (d.tarih > sonTarih) sonTarih = d.tarih;
                });

                const tumIzinler = await db.select().from(kapaliGunler);
                const aktifEgitmenler = await aktifEgitmenleriGetir();
                const { uzmanKey, kortNo, egitmen: telafiEgitmeni } = egitmenVeKortCozumle(aktifEgitmenler, k.alanId || 1, k.notlar || undefined);
                const telafiFormati = kayitFormatiniCozumle(k.dersFormati, k.rezervasyonTuru || '');
                const grupMu = telafiFormati === 'grup';

                if (!egitmenMesaiDisindaMi(telafiEgitmeni, k.saat)) {
                    for (let offset = 1; offset <= 60; offset++) {
                        const adayTarih = tarihEkle(sonTarih, offset);
                        const gIndex = gunIndexBul(adayTarih);
                        if (gIndex === 0 || !gunlerSet.has(gIndex)) continue;

                        if (izinKapaliMi(tumIzinler, adayTarih, k.saat, gIndex, uzmanKey, kortNo)) continue;

                        const mevcut = await db.select().from(rezervasyonlar).where(
                            and(
                                eq(rezervasyonlar.tarih, adayTarih),
                                eq(rezervasyonlar.saat, k.saat),
                                eq(rezervasyonlar.alanId, kortNo)
                            )
                        );

                        const musait = grupMu
                            ? (!mevcut.some(m => !isGrupDers(m.dersFormati, m.rezervasyonTuru || '')) && mevcut.length < GRUP_KAPASITE)
                            : mevcut.length === 0;

                        if (musait) {
                            await db.insert(rezervasyonlar).values({
                                alanId: kortNo,
                                tarih: adayTarih,
                                saat: k.saat,
                                kisiAdi: k.kisiAdi,
                                telefon: k.telefon,
                                rezervasyonTuru: k.rezervasyonTuru,
                                dersFormati: telafiFormati,
                                cinsiyet: k.cinsiyet,
                                notlar: uzmanKey,
                                onayDurumu: 'onaylandi',
                                seriId: k.seriId,
                                musteriId: k.musteriId
                            });
                            telafiTarih = adayTarih;
                            break;
                        }
                    }
                }
            }

            const islemTuru = hakIade === 'telafi' ? 'telafi' : (hakIade === 'evet' ? 'iade' : 'yandi');
            await db.insert(iptalKayitlari).values({
                musteriId: k.musteriId,
                kisiAdi: k.kisiAdi,
                telefon: k.telefon,
                tarih: k.tarih,
                saat: k.saat,
                rezervasyonTuru: k.rezervasyonTuru,
                dersFormati: kayitFormatiniCozumle(k.dersFormati, k.rezervasyonTuru || ''),
                egitmen: k.notlar,
                islemTuru,
                telafiTarih,
                iptalEden: kimlik.kullaniciAdi
            });
        }
        
        return new Response(JSON.stringify({ success: true, telafiTarih, silinenAdet }), { status: 200 });
    } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
};