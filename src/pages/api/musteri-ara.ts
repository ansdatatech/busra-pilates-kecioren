import type { APIRoute } from 'astro';
import { db } from '../../db';
import { musteriler, rezervasyonlar } from '../../db/schema';
import { ilike, or } from 'drizzle-orm';
import { jwtVerify } from 'jose';

export const prerender = false;
const JWT_SECRET = new TextEncoder().encode(import.meta.env.JWT_SECRET || 'gizli_anahtar_degistir_lutfen');

function isimFormatla(isim: string) {
    if (!isim) return "";
    const parcalar = isim.trim().split(/\s+/);
    if (parcalar.length === 1) {
        return parcalar[0].charAt(0).toLocaleUpperCase('tr-TR') + parcalar[0].slice(1).toLocaleLowerCase('tr-TR');
    }
    const sonKelime = parcalar.pop()?.toLocaleUpperCase('tr-TR') || '';
    const ilkKisim = parcalar.map(p => p.charAt(0).toLocaleUpperCase('tr-TR') + p.slice(1).toLocaleLowerCase('tr-TR')).join(' ');
    return ilkKisim + ' ' + sonKelime;
}

function telefonFormatla(tel: string) {
    if (!tel) return '';
    const temiz = tel.replace(/\D/g, '');
    if (temiz.length === 11 && temiz.startsWith('0')) {
        return `0(${temiz.substring(1,4)}) ${temiz.substring(4,7)} ${temiz.substring(7,9)} ${temiz.substring(9,11)}`;
    }
    return tel; 
}

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
        const q = url.searchParams.get('q');

        if (!q || q.length < 2) {
            return new Response(JSON.stringify([]), { status: 200 });
        }

        const aramaMetni = `%${q}%`;

        const mSonuclar = await db.select().from(musteriler).where(
            or(
                ilike(musteriler.adSoyad, aramaMetni),
                ilike(musteriler.telefon, aramaMetni)
            )
        ).limit(20);

        const rSonuclar = await db.select({
            adSoyad: rezervasyonlar.kisiAdi,
            telefon: rezervasyonlar.telefon,
            cinsiyet: rezervasyonlar.cinsiyet
        }).from(rezervasyonlar).where(
            or(
                ilike(rezervasyonlar.kisiAdi, aramaMetni),
                ilike(rezervasyonlar.telefon, aramaMetni)
            )
        ).limit(20);

        const islenenAnahtarlar = new Set();
        const tekilListe: { adSoyad: string; telefon: string; kalanDers?: number | null; cinsiyet?: string | null }[] = [];

        // Önce musteriler tablosunu işle ki kalanDers ve cinsiyet bilgisi korunsun
        mSonuclar.forEach(k => {
            const duzgunIsim = isimFormatla(k.adSoyad);
            const telTemiz = k.telefon ? k.telefon.replace(/\D/g, '') : '';
            const benzersizAnahtar = telTemiz ? telTemiz : duzgunIsim.toLocaleLowerCase('tr-TR');

            if (!islenenAnahtarlar.has(benzersizAnahtar)) {
                islenenAnahtarlar.add(benzersizAnahtar);
                tekilListe.push({
                    adSoyad: duzgunIsim,
                    telefon: telefonFormatla(k.telefon || ''),
                    kalanDers: k.kalanDers,
                    cinsiyet: k.cinsiyet || 'kadin'
                });
            }
        });

        rSonuclar.forEach(k => {
            const duzgunIsim = isimFormatla(k.adSoyad);
            const telTemiz = k.telefon ? k.telefon.replace(/\D/g, '') : '';
            const benzersizAnahtar = telTemiz ? telTemiz : duzgunIsim.toLocaleLowerCase('tr-TR');

            if (!islenenAnahtarlar.has(benzersizAnahtar)) {
                islenenAnahtarlar.add(benzersizAnahtar);
                tekilListe.push({
                    adSoyad: duzgunIsim,
                    telefon: telefonFormatla(k.telefon || ''),
                    kalanDers: null,
                    cinsiyet: k.cinsiyet || 'kadin'
                });
            }
        });

        tekilListe.sort((a, b) => a.adSoyad.localeCompare(b.adSoyad, 'tr'));
        return new Response(JSON.stringify(tekilListe.slice(0, 8)), { status: 200, headers: { 'Content-Type': 'application/json' } });

    } catch (error: any) {
        console.error("Müşteri arama hatası:", error);
        return new Response(JSON.stringify([]), { status: 500 });
    }
};