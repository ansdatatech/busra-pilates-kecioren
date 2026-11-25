import type { APIRoute } from 'astro';
import { db } from '../../db';
import { egitmenler } from '../../db/schema';
import { asc, eq } from 'drizzle-orm';
import { jwtVerify } from 'jose';

export const prerender = false;
const JWT_SECRET = new TextEncoder().encode(import.meta.env.JWT_SECRET || 'gizli_anahtar_degistir_lutfen');

async function kimlikGetir(cookies: any) {
    try {
        const token = cookies.get('auth_token')?.value;
        if (!token) return null;
        const { payload } = await jwtVerify(token, JWT_SECRET);
        return { rol: payload.rol as string, kullaniciAdi: payload.kullaniciAdi as string };
    } catch {
        return null;
    }
}

function anahtarOlustur(ad: string): string {
    const trMap: Record<string, string> = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u' };
    const temiz = ad
        .toLocaleLowerCase('tr-TR')
        .replace(/[çğıöşü]/g, (m) => trMap[m] || m)
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return temiz || `egitmen_${Date.now()}`;
}

// 1. EĞİTMENLERİ GETİR (Tablo boşsa varsayılan 3 hocayı otomatik oluşturur)
export const GET: APIRoute = async ({ cookies }) => {
    const kimlik = await kimlikGetir(cookies);
    if (!kimlik) return new Response(JSON.stringify({ error: "Yetkisiz erişim!" }), { status: 401 });

    try {
        let liste = await db.select().from(egitmenler).orderBy(asc(egitmenler.id));

        if (liste.length === 0) {
            await db.insert(egitmenler).values([
                { adSoyad: 'İlayda Hoca', anahtar: 'ilayda', baslangicSaati: 9, bitisSaati: 17, renk: '#6B4C63', aktif: true },
                { adSoyad: 'Esra Hoca', anahtar: 'esra', baslangicSaati: 15, bitisSaati: 22, renk: '#9E6B8E', aktif: true },
                { adSoyad: 'Büşra Hoca', anahtar: 'busra', baslangicSaati: 17, bitisSaati: 22, renk: '#E563B1', aktif: true },
            ]);
            liste = await db.select().from(egitmenler).orderBy(asc(egitmenler.id));
        }

        return new Response(JSON.stringify(liste), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
};

// 2. YENİ EĞİTMEN EKLE (Sadece Yönetici)
export const POST: APIRoute = async ({ request, cookies }) => {
    const kimlik = await kimlikGetir(cookies);
    if (!kimlik || kimlik.rol !== 'yonetici') {
        return new Response(JSON.stringify({ error: "Bu işlem için yönetici yetkisi gerekir." }), { status: 403 });
    }

    try {
        const body = await request.json();
        const adSoyad = (body.adSoyad || '').trim();
        if (!adSoyad) return new Response(JSON.stringify({ error: "Eğitmen adı gerekli." }), { status: 400 });

        let anahtar = anahtarOlustur(adSoyad);
        const mevcut = await db.select().from(egitmenler).where(eq(egitmenler.anahtar, anahtar)).limit(1);
        if (mevcut.length > 0) anahtar = `${anahtar}_${Date.now().toString().slice(-3)}`;

        const [yeni] = await db.insert(egitmenler).values({
            adSoyad,
            anahtar,
            baslangicSaati: parseInt(body.baslangicSaati) || 9,
            bitisSaati: parseInt(body.bitisSaati) || 22,
            renk: body.renk || '#6B4C63',
            aktif: true
        }).returning();

        return new Response(JSON.stringify(yeni), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
};

// 3. EĞİTMEN GÜNCELLE / PASİFE AL / AKTİF ET (Sadece Yönetici)
export const PUT: APIRoute = async ({ request, cookies }) => {
    const kimlik = await kimlikGetir(cookies);
    if (!kimlik || kimlik.rol !== 'yonetici') {
        return new Response(JSON.stringify({ error: "Bu işlem için yönetici yetkisi gerekir." }), { status: 403 });
    }

    try {
        const body = await request.json();
        if (!body.id) return new Response(JSON.stringify({ error: "Eğitmen ID gerekli." }), { status: 400 });

        const guncelAlanlar: any = {};
        if (body.adSoyad !== undefined) guncelAlanlar.adSoyad = body.adSoyad.trim();
        if (body.baslangicSaati !== undefined) guncelAlanlar.baslangicSaati = parseInt(body.baslangicSaati);
        if (body.bitisSaati !== undefined) guncelAlanlar.bitisSaati = parseInt(body.bitisSaati);
        if (body.renk !== undefined) guncelAlanlar.renk = body.renk;
        if (body.aktif !== undefined) guncelAlanlar.aktif = Boolean(body.aktif);

        await db.update(egitmenler).set(guncelAlanlar).where(eq(egitmenler.id, parseInt(body.id)));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
    } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
};