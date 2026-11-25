import type { APIRoute } from 'astro';
import { db } from '../../db';
import { musteriler, rezervasyonlar } from '../../db/schema';
import { desc, eq } from 'drizzle-orm';
import { jwtVerify } from 'jose';

export const prerender = false;
const JWT_SECRET = new TextEncoder().encode(import.meta.env.JWT_SECRET || 'gizli_anahtar_degistir_lutfen');

function bugunYerelBilgi() {
    const simdi = new Date();
    const yil = simdi.getFullYear();
    const ay = String(simdi.getMonth() + 1).padStart(2, '0');
    const gun = String(simdi.getDate()).padStart(2, '0');
    const bugunIso = `${yil}-${ay}-${gun}`;
    const suankiSaat = String(simdi.getHours()).padStart(2, '0') + ':' + String(simdi.getMinutes()).padStart(2, '0');
    return { bugunIso, suankiSaat };
}

export const GET: APIRoute = async ({ cookies }) => {
    const token = cookies.get('auth_token')?.value;
    if (!token) return new Response(JSON.stringify({ error: "Yetkisiz erişim!" }), { status: 401 });
    try { await jwtVerify(token, JWT_SECRET); } catch (error) {
        return new Response(JSON.stringify({ error: "Geçersiz veya süresi dolmuş oturum!" }), { status: 403 });
    }

    try {
        const [liste, tumRez] = await Promise.all([
            db.select().from(musteriler).orderBy(desc(musteriler.id)),
            db.select().from(rezervasyonlar)
        ]);

        const { bugunIso, suankiSaat } = bugunYerelBilgi();

        const zenginListe = liste.map(m => {
            const mTel = m.telefon ? m.telefon.replace(/\D/g, '') : '';
            const mAd = (m.adSoyad || '').trim().toLocaleLowerCase('tr-TR');

            const uyeRezleri = tumRez.filter(r => {
                if (r.musteriId && r.musteriId === m.id) return true;
                const rTel = r.telefon ? r.telefon.replace(/\D/g, '') : '';
                if (mTel && rTel && mTel === rTel) return true;
                return (r.kisiAdi || '').trim().toLocaleLowerCase('tr-TR') === mAd;
            });

            const gelecekler = uyeRezleri
                .filter(r => r.tarih > bugunIso || (r.tarih === bugunIso && (r.saat || '00:00') >= suankiSaat))
                .sort((a, b) => `${a.tarih} ${a.saat}`.localeCompare(`${b.tarih} ${b.saat}`));

            const tamamlananDers = uyeRezleri.length - gelecekler.length;
            const gelecekDers = gelecekler.length;
            const sonGelecek = gelecekler.length > 0 ? gelecekler[gelecekler.length - 1] : null;
            const ilkGelecek = gelecekler.length > 0 ? gelecekler[0] : null;

            return {
                ...m,
                gelecekDers,
                tamamlananDers,
                sonDersTarihi: sonGelecek ? sonGelecek.tarih : null,
                sonDersSaati: sonGelecek ? sonGelecek.saat : null,
                sonrakiDersTarihi: ilkGelecek ? ilkGelecek.tarih : null
            };
        });

        return new Response(JSON.stringify(zenginListe), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error: any) {
        return new Response(JSON.stringify({ error: "Veri çekilemedi." }), { status: 500 });
    }
};

export const PUT: APIRoute = async ({ request, cookies }) => {
    const token = cookies.get('auth_token')?.value;
    if (!token) {
        return new Response(JSON.stringify({ error: "Yetkisiz erişim!" }), { status: 401 });
    }
    try {
        await jwtVerify(token, JWT_SECRET);
    } catch (error) {
        return new Response(JSON.stringify({ error: "Geçersiz veya süresi dolmuş oturum!" }), { status: 403 });
    }

    try {
        const body = await request.json();
        const { id, adSoyad, telefon, toplamDers, kalanDers, cinsiyet, notlar } = body;

        if (!id) {
            return new Response(JSON.stringify({ error: "Üye ID gerekli." }), { status: 400 });
        }

        const guncellenecek: Record<string, any> = {};
        if (adSoyad !== undefined && String(adSoyad).trim()) guncellenecek.adSoyad = String(adSoyad).trim();
        if (telefon !== undefined) guncellenecek.telefon = String(telefon).trim();
        if (cinsiyet !== undefined) guncellenecek.cinsiyet = cinsiyet;
        if (toplamDers !== undefined) guncellenecek.toplamDers = Number(toplamDers) || 0;
        if (kalanDers !== undefined) guncellenecek.kalanDers = Number(kalanDers) || 0;
        if (notlar !== undefined) guncellenecek.notlar = String(notlar);

        if (Object.keys(guncellenecek).length === 0) {
            return new Response(JSON.stringify({ error: "Güncellenecek alan yok." }), { status: 400 });
        }

        await db
            .update(musteriler)
            .set(guncellenecek)
            .where(eq(musteriler.id, Number(id)));

        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error: any) {
        return new Response(JSON.stringify({ error: "Üye bilgileri güncellenemedi." }), { status: 500 });
    }
};