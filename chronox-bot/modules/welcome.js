'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 *  Karşılama modülü — etiketli, samimi mesaj + her seferinde rastgele GIF
 * ════════════════════════════════════════════════════════════════════════════
 *  • /welcome channel        → karşılama kanalını seçer (guild_settings.welcome_channel,
 *                              yani /config welcome ile aynı ayar; ikisi birbirine uyumlu)
 *  • /welcome ...            → gif-add · gif-remove · gif-list · test · disable
 *  • GIF kaynakları          → sunucunun kendi GIF havuzu (welcome_gifs tablosu)
 *                              ve/veya Giphy (GIPHY_API_KEY varsa)
 *  • /config welcome message → özel metin hâlâ çalışır; yazılmışsa rastgele metin yerine o kullanılır
 *
 *  index.js tarafı bu dosyaya yalnızca şunları verir: db, ayar yardımcıları ve ortak yanıt fonksiyonları.
 */
const { ChannelType, EmbedBuilder, PermissionFlagsBits: P, SlashCommandBuilder } = require('discord.js');

const MAX_GIFS = 50;

/** {user} = etiket, {username} = kullanıcı adı, {server} = sunucu adı, {count} = üye sayısı */
const MESSAGES = [
  '{user} seni burada görmek ne güzel! 🎉 Aramıza hoş geldin, buradan sohbete katılabilirsin.',
  'Hey {user}! 👋 **{server}** ailesine hoş geldin. Çekinme, sohbete dalabilirsin!',
  'Vay vay, kimler gelmiş! {user} aramıza katıldı 🥳 Rahatına bak, sohbet seni bekliyor.',
  '{user} hoş geldin! ✨ Seninle birlikte **{count}** kişi olduk, buradan sohbete katılabilirsin.',
  'Selam {user}! 🙌 Sen gelince ortam şenlendi. Gel, bir şeyler yaz da tanışalım!',
  '{user} geldi, ortam ısındı! 🔥 Hoş geldin, sohbete istediğin zaman katılabilirsin.',
  'Aramıza hoş geldin {user}! 💫 Kendini evinde hisset, buradan sohbete katılabilirsin.',
  '{user}, seni aramızda görmek harika! 🎊 **{server}** seni bekliyordu.',
];

/** Giphy'de aranacak, karşılamayla bağlantılı sorgular (GIPHY_API_KEY varsa kullanılır). */
const GIPHY_QUERIES = [
  'anime welcome',
  'anime wave hello',
  'welcome wave',
  'hello anime greeting',
  'saitama genos punch',
  'one punch man hello',
  'welcome party celebration',
];

const EMBED_COLORS = [0x5865f2, 0xeb459e, 0xfee75c, 0x57f287, 0xed4245, 0x9b59b6];

/** Karşılama kanalında botun sahip olması gereken izinler */
const NEEDED_PERMS = {
  ViewChannel: 'Kanalı Görüntüle',
  SendMessages: 'Mesaj Gönder',
  EmbedLinks: 'Bağlantıları Göm',
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Yalnızca https ve .gif ile biten doğrudan bağlantıları kabul eder. */
function validateGifUrl(input) {
  try {
    const url = new URL(String(input).trim());
    if (url.protocol !== 'https:' || !/\.gif$/i.test(url.pathname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

module.exports = function createWelcomeModule({ db, getSettings, setSetting, embed, COLOR, EPHEMERAL, fail, succeed }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS welcome_gifs (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      url      TEXT NOT NULL,
      added_by TEXT,
      UNIQUE (guild_id, url)
    );
    CREATE INDEX IF NOT EXISTS idx_welcome_gifs_guild ON welcome_gifs (guild_id);
  `);

  const Q = {
    add: db.prepare('INSERT OR IGNORE INTO welcome_gifs (guild_id, url, added_by) VALUES (?, ?, ?)'),
    remove: db.prepare('DELETE FROM welcome_gifs WHERE guild_id = ? AND id = ?'),
    list: db.prepare('SELECT id, url FROM welcome_gifs WHERE guild_id = ? ORDER BY id'),
    count: db.prepare('SELECT COUNT(*) AS total FROM welcome_gifs WHERE guild_id = ?'),
    random: db.prepare('SELECT url FROM welcome_gifs WHERE guild_id = ? ORDER BY RANDOM() LIMIT 1'),
  };

  /* ── GIF seçimi ─────────────────────────────────────────────────────────── */
  /** Giphy'den rastgele karşılama GIF'i çeker; anahtar yoksa ya da hata olursa null döner. */
  async function fetchGiphyGif() {
    const apiKey = process.env.GIPHY_API_KEY;
    if (!apiKey) return null;

    const params = new URLSearchParams({
      api_key: apiKey,
      q: pick(GIPHY_QUERIES),
      limit: '20',
      offset: String(Math.floor(Math.random() * 30)),
      rating: 'pg-13',
      lang: 'en',
    });

    try {
      const res = await fetch(`https://api.giphy.com/v1/gifs/search?${params}`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return null;
      const json = await res.json();
      const urls = (json.data ?? [])
        .map((g) => g?.images?.downsized_medium?.url ?? g?.images?.original?.url)
        .filter(Boolean);
      return urls.length ? pick(urls) : null;
    } catch (err) {
      console.warn('[welcome] Giphy isteği başarısız:', err.message);
      return null;
    }
  }

  /** Sunucunun GIF havuzu ile Giphy arasından rastgele bir GIF seçer. */
  async function resolveGif(guildId) {
    const custom = Q.random.get(guildId)?.url ?? null;
    const hasApi = Boolean(process.env.GIPHY_API_KEY);

    if (custom && hasApi) {
      const chance = Number(process.env.CUSTOM_GIF_CHANCE ?? 0.5);
      if (Math.random() < (Number.isFinite(chance) ? chance : 0.5)) return custom;
      return (await fetchGiphyGif()) ?? custom;
    }
    return custom ?? (await fetchGiphyGif());
  }

  /* ── Mesaj oluşturma / gönderme ─────────────────────────────────────────── */
  async function buildPayload(member, settings, withEmbed = true) {
    const { guild } = member;
    const count = guild.memberCount;
    const tpl = settings.welcome_message || pick(MESSAGES);

    const content = tpl
      .replaceAll('{user}', `<@${member.id}>`)
      .replaceAll('{username}', member.user.username)
      .replaceAll('{server}', guild.name)
      .replaceAll('{count}', count.toLocaleString('tr-TR'));

    const payload = { content, allowedMentions: { users: [member.id] } };

    if (withEmbed) {
      const gif = await resolveGif(guild.id);
      if (gif) {
        payload.embeds = [
          new EmbedBuilder()
            .setColor(pick(EMBED_COLORS))
            .setImage(gif)
            .setFooter({ text: `${guild.name} • ${count.toLocaleString('tr-TR')}. üye` })
            .setTimestamp(),
        ];
      }
    }
    return payload;
  }

  /** Üye katıldığında çağrılır. Mesaj gönderildiyse true döner. Hata fırlatmaz. */
  async function sendWelcome(member, settings = getSettings(member.guild.id)) {
    try {
      if (!settings.welcome_channel || member.user.bot) return false;

      const { guild } = member;
      const channel =
        guild.channels.cache.get(settings.welcome_channel) ??
        (await guild.channels.fetch(settings.welcome_channel).catch(() => null));
      if (!channel?.isTextBased()) return false;

      const me = guild.members.me ?? (await guild.members.fetchMe());
      const perms = channel.permissionsFor(me);
      if (!perms?.has([P.ViewChannel, P.SendMessages])) {
        console.warn(`[welcome] ${guild.name} / #${channel.name}: mesaj gönderme izni yok.`);
        return false;
      }

      await channel.send(await buildPayload(member, settings, perms.has(P.EmbedLinks)));
      return true;
    } catch (err) {
      console.error('[welcome] Karşılama gönderilemedi:', err);
      return false;
    }
  }

  /* ── Komut: /welcome <alt komut> ────────────────────────────────────────── */
  const welcomeCommand = {
    perm: P.ManageGuild,
    data: new SlashCommandBuilder()
      .setName('welcome')
      .setDescription('Karşılama mesajı ve GIF havuzu ayarları')
      .addSubcommand((s) =>
        s
          .setName('channel')
          .setDescription('Yeni üyeler için GIF’li karşılama mesajının gönderileceği kanalı ayarlar')
          .addChannelOption((o) =>
            o
              .setName('channel')
              .setDescription('Karşılama mesajlarının gönderileceği kanal')
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
              .setRequired(true)
          )
      )
      .addSubcommand((s) =>
        s
          .setName('gif-add')
          .setDescription('Karşılama GIF havuzuna yeni bir GIF ekler')
          .addStringOption((o) =>
            o.setName('url').setDescription('.gif ile biten doğrudan GIF bağlantısı (https://...)').setMaxLength(500).setRequired(true)
          )
      )
      .addSubcommand((s) =>
        s
          .setName('gif-remove')
          .setDescription('GIF havuzundan bir GIF siler')
          .addIntegerOption((o) => o.setName('id').setDescription('GIF numarası (/welcome gif-list ile görebilirsin)').setMinValue(1).setRequired(true))
      )
      .addSubcommand((s) => s.setName('gif-list').setDescription('GIF havuzunu listeler'))
      .addSubcommand((s) => s.setName('test').setDescription('Karşılama mesajının önizlemesini sana gösterir'))
      .addSubcommand((s) => s.setName('disable').setDescription('Karşılama mesajlarını kapatır')),

    async execute(i) {
      const gid = i.guildId;
      const sub = i.options.getSubcommand();

      if (sub === 'channel') {
        const picked = i.options.getChannel('channel', true);
        const channel = i.guild.channels.cache.get(picked.id) ?? (await i.guild.channels.fetch(picked.id));
        const me = i.guild.members.me ?? (await i.guild.members.fetchMe());
        const missing = channel.permissionsFor(me)?.missing(Object.keys(NEEDED_PERMS)) ?? Object.keys(NEEDED_PERMS);

        if (missing.length) {
          return fail(i, `${channel} kanalında şu izinlere ihtiyacım var: **${missing.map((p) => NEEDED_PERMS[p]).join(', ')}**. İzinleri verip komutu tekrar çalıştır.`);
        }

        setSetting(gid, 'welcome_channel', channel.id);
        return succeed(
          i,
          `Karşılama mesajları artık ${channel} kanalına gönderilecek.\nÖnizleme: \`/welcome test\` • GIF eklemek için: \`/welcome gif-add\``
        );
      }

      if (sub === 'gif-add') {
        const url = validateGifUrl(i.options.getString('url', true));
        if (!url) {
          return fail(i, 'Geçersiz bağlantı. `https://` ile başlayan ve **.gif** ile biten doğrudan bir GIF adresi girmelisin. (GIF’e sağ tık → “Resim adresini kopyala”; Tenor/Giphy sayfa linkleri çalışmaz.)');
        }
        if (Q.count.get(gid).total >= MAX_GIFS) {
          return fail(i, `GIF havuzu dolu (en fazla ${MAX_GIFS}). Önce \`/welcome gif-remove\` ile yer aç.`);
        }
        const added = Q.add.run(gid, url, i.user.id).changes > 0;
        return added
          ? succeed(i, 'GIF havuza eklendi! Gelecek karşılamalarda çıkabilir.')
          : fail(i, 'Bu GIF zaten havuzda var.');
      }

      if (sub === 'gif-remove') {
        const id = i.options.getInteger('id', true);
        return Q.remove.run(gid, id).changes > 0
          ? succeed(i, `#${id} numaralı GIF silindi.`)
          : fail(i, 'Bu numarada bir GIF bulunamadı.');
      }

      if (sub === 'gif-list') {
        const gifs = Q.list.all(gid);
        if (!gifs.length) return fail(i, 'GIF havuzu boş. `/welcome gif-add` ile ekleyebilirsin.');

        const lines = [];
        let length = 0;
        for (const g of gifs) {
          const line = `**#${g.id}** — [bağlantı](${g.url})`;
          if (length + line.length > 3800) break;
          lines.push(line);
          length += line.length + 1;
        }
        if (lines.length < gifs.length) lines.push(`… ve ${gifs.length - lines.length} GIF daha.`);

        return i.reply({
          embeds: [embed(COLOR.info, `🎞️ Karşılama GIF havuzu (${gifs.length}/${MAX_GIFS})`, lines.join('\n'))],
          flags: EPHEMERAL,
        });
      }

      if (sub === 'test') {
        await i.deferReply({ flags: EPHEMERAL });
        const settings = getSettings(gid);
        const canEmbed = i.channel?.permissionsFor?.(i.guild.members.me)?.has(P.EmbedLinks) ?? true;
        return i.editReply(await buildPayload(i.member, settings, canEmbed));
      }

      if (sub === 'disable') {
        if (!getSettings(gid).welcome_channel) return fail(i, 'Karşılama mesajı zaten kapalı.');
        setSetting(gid, 'welcome_channel', null);
        return succeed(i, 'Karşılama mesajları kapatıldı. Tekrar açmak için `/welcome channel` ile kanal seç.');
      }
    },
  };

  return { commands: [welcomeCommand], sendWelcome, buildPayload };
};
