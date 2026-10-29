'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 *  ChronoxVoice modülü — "kanala gir, kendi odanı oluştur" + butonlu kontrol paneli
 * ════════════════════════════════════════════════════════════════════════════
 *  • /chronoxvoice setup    → "➕ Oda Oluştur" kanalını (hub) kurar ve kontrol panelini kanala gönderir
 *  • /chronoxvoice panel    → paneli (tekrar) bir kanala gönderir
 *  • /chronoxvoice disable  → sistemi kapatır
 *  • Hub'a giren üye için ses odası açılır, üye oraya taşınır ve odanın sahibi olur
 *  • Oda boşalınca otomatik silinir; sahip çıkarsa odada kalan ilk kişiye devredilir
 *  • Oda yönetimi KOMUTLA değil, paneldeki butonlarla yapılır (customId'ler "tv:" ile başlar)
 *
 *  Botun gerekli izinleri: Kanalları Yönet, Rolleri Yönet (izin ayarı için), Üyeleri Taşı,
 *  Kanalı Görüntüle, Bağlan (+ panel kanalında Mesaj Gönder, Bağlantı Göm).
 */
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ModalBuilder,
  PermissionFlagsBits: P,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} = require('discord.js');

const OWNER_PERMS = { ViewChannel: true, Connect: true, Speak: true, MoveMembers: true };
const RENAME_COOLDOWN_MS = 5 * 60_000; // Discord kanal adı değişimini sıkı sınırlar (10 dk'da 2 kez)

/** Paneldeki butonlar: [id, emoji, etiket] — 5'erli satırlar halinde dizilir */
const BUTTONS = [
  ['name', '📝', 'Oda İsmi'], ['limit', '👥', 'Oda Limiti'], ['lock', '🔒', 'Gizlilik'], ['hide', '👁️', 'Gizle'], ['chat', '💬', 'Sohbet'],
  ['trust', '✅', 'Güvenilir'], ['untrust', '❎', 'Güvensiz'], ['invite', '📨', 'Davet'], ['kick', '👢', 'Sesten At'], ['region', '🌐', 'Bölge'],
  ['ban', '⛔', 'Engelle'], ['unban', '🔓', 'Engeli Kaldır'], ['claim', '👑', 'Sahiplen'], ['transfer', '🔄', 'Odayı Devret'], ['delete', '🗑️', 'Sil'],
];

/** Kullanıcı seçtirilen işlemlerin açıklamaları */
const PICK_TEXT = {
  trust: '✅ **Güvenilir** listesine eklenecek kullanıcıyı seç. (Oda kilitli/gizli olsa bile girebilir.)',
  untrust: '❎ **Güvenilir** listesinden çıkarılacak kullanıcıyı seç.',
  invite: '📨 Odaya **davet** edilecek kullanıcıyı seç. (DM ile bağlantı gider, girmesine izin verilir.)',
  kick: '👢 Odadan **atılacak** kullanıcıyı seç. (Tekrar girebilir; engellemek için ⛔ Engelle.)',
  ban: '⛔ Odadan **engellenecek** kullanıcıyı seç. (Atılır ve tekrar giremez.)',
  unban: '🔓 Engeli **kaldırılacak** kullanıcıyı seç.',
  transfer: '🔄 Sahipliği **devredeceğin** kişiyi seç. (Odanın içinde olmalı.)',
};

const REGIONS = [
  ['auto', 'Otomatik'], ['brazil', 'Brezilya'], ['hongkong', 'Hong Kong'], ['india', 'Hindistan'], ['japan', 'Japonya'],
  ['rotterdam', 'Rotterdam'], ['russia', 'Rusya'], ['singapore', 'Singapur'], ['south-korea', 'Güney Kore'],
  ['southafrica', 'Güney Afrika'], ['sydney', 'Sidney'], ['us-central', 'ABD Merkez'], ['us-east', 'ABD Doğu'],
  ['us-south', 'ABD Güney'], ['us-west', 'ABD Batı'],
];

module.exports = function createChronoxVoiceModule({ client, db, embed, COLOR, EPHEMERAL, fail, succeed, truncate }) {
  // Eski sürümde (TempVoice adıyla) kurulduysa tabloları yeni isme taşı — veri kaybolmaz
  for (const [oldName, newName] of [['tempvoice_hubs', 'chronoxvoice_hubs'], ['tempvoice_channels', 'chronoxvoice_channels']]) {
    const exists = (n) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(n);
    if (exists(oldName) && !exists(newName)) db.exec(`ALTER TABLE ${oldName} RENAME TO ${newName}`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS chronoxvoice_hubs (
      guild_id    TEXT PRIMARY KEY,
      hub_id      TEXT NOT NULL,
      category_id TEXT
    );
    CREATE TABLE IF NOT EXISTS chronoxvoice_channels (
      channel_id TEXT PRIMARY KEY,
      guild_id   TEXT NOT NULL,
      owner_id   TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  const Q = {
    getHub: db.prepare('SELECT * FROM chronoxvoice_hubs WHERE guild_id = ?'),
    setHub: db.prepare(
      `INSERT INTO chronoxvoice_hubs (guild_id, hub_id, category_id) VALUES (?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET hub_id = excluded.hub_id, category_id = excluded.category_id`
    ),
    delHub: db.prepare('DELETE FROM chronoxvoice_hubs WHERE guild_id = ?'),
    delHubByChannel: db.prepare('DELETE FROM chronoxvoice_hubs WHERE hub_id = ?'),
    insertChannel: db.prepare('INSERT OR REPLACE INTO chronoxvoice_channels (channel_id, guild_id, owner_id, created_at) VALUES (?, ?, ?, ?)'),
    getChannel: db.prepare('SELECT * FROM chronoxvoice_channels WHERE channel_id = ?'),
    setOwner: db.prepare('UPDATE chronoxvoice_channels SET owner_id = ? WHERE channel_id = ?'),
    delChannel: db.prepare('DELETE FROM chronoxvoice_channels WHERE channel_id = ?'),
    allChannels: db.prepare('SELECT * FROM chronoxvoice_channels'),
  };

  const creating = new Set(); // "guild:user" → aynı anda iki oda açılmasın
  const renameAt = new Map(); // channelId → son ad değişimi

  const humansIn = (channel) => channel.members.filter((m) => !m.user.bot);
  const isDenied = (channel, id, perm) => channel.permissionOverwrites.cache.get(id)?.deny.has(perm) ?? false;

  /* ── Sahiplik ─────────────────────────────────────────────────────────── */
  async function setOwner(channel, row, newOwnerId, { keepOldAccess = false } = {}) {
    Q.setOwner.run(newOwnerId, channel.id);
    if (keepOldAccess) {
      await channel.permissionOverwrites
        .edit(row.owner_id, { ViewChannel: true, Connect: true, Speak: null, MoveMembers: null }, { reason: 'ChronoxVoice: sahiplik devri' })
        .catch(() => {});
    } else {
      await channel.permissionOverwrites.delete(row.owner_id, 'ChronoxVoice: sahiplik devri').catch(() => {});
    }
    await channel.permissionOverwrites.edit(newOwnerId, OWNER_PERMS, { reason: 'ChronoxVoice: yeni oda sahibi' }).catch(() => {});
  }

  /* ── Oda oluşturma (hub'a girince) ────────────────────────────────────── */
  async function createRoom(newS, hub) {
    const { guild, member } = newS;
    const key = `${guild.id}:${member.id}`;
    if (creating.has(key)) return;
    creating.add(key);
    let channel = null;
    try {
      const hubChannel = guild.channels.cache.get(hub.hub_id);
      const parentId = hub.category_id && guild.channels.cache.has(hub.category_id) ? hub.category_id : hubChannel?.parentId ?? null;

      channel = await guild.channels.create({
        name: truncate(`🔊 Oda • ${member.displayName}`, 100),
        type: ChannelType.GuildVoice,
        parent: parentId,
        reason: `ChronoxVoice: ${member.user.username} için oda`,
      });
      await channel.permissionOverwrites.edit(member.id, OWNER_PERMS, { reason: 'ChronoxVoice: oda sahibi' });
      Q.insertChannel.run(channel.id, guild.id, member.id, Date.now());

      // Oda hazırlanırken üye hub'dan çıktıysa odayı boşuna bırakma
      if (member.voice.channelId !== hub.hub_id) throw new Error('left');
      await member.voice.setChannel(channel, 'ChronoxVoice: oda oluşturuldu');
    } catch (err) {
      if (channel) {
        await channel.delete('ChronoxVoice: oda hazırlanamadı').catch(() => {});
        Q.delChannel.run(channel.id);
      }
      if (err.message !== 'left') console.error('[chronoxvoice] oda oluşturulamadı:', err.message);
    } finally {
      creating.delete(key);
    }
  }

  /* ── Odadan çıkış: boşsa sil, sahip çıktıysa devret ───────────────────── */
  async function afterLeave(guild, row, leaverId) {
    const channel = guild.channels.cache.get(row.channel_id) ?? (await guild.channels.fetch(row.channel_id).catch(() => null));
    if (!channel) {
      Q.delChannel.run(row.channel_id);
      return;
    }
    const humans = humansIn(channel);
    if (humans.size === 0) {
      renameAt.delete(channel.id);
      // Satır, ChannelDelete olayında silinir (log tarafı bu kanalı "oda" olarak tanıyıp loglamasın diye)
      await channel.delete('ChronoxVoice: oda boşaldı').catch((err) => {
        console.error('[chronoxvoice] oda silinemedi:', err.message);
      });
      return;
    }
    if (row.owner_id === leaverId) await setOwner(channel, row, humans.first().id);
  }

  async function handleVoiceState(oldS, newS) {
    try {
      const guild = newS.guild;
      const member = newS.member ?? oldS.member;
      if (!guild || !member || oldS.channelId === newS.channelId) return;

      if (oldS.channelId) {
        const row = Q.getChannel.get(oldS.channelId);
        if (row) await afterLeave(guild, row, member.id);
      }
      if (newS.channelId && !member.user.bot) {
        const hub = Q.getHub.get(guild.id);
        if (hub && hub.hub_id === newS.channelId) await createRoom(newS, hub);
      }
    } catch (err) {
      console.error('[chronoxvoice]', err);
    }
  }

  /** Kanal silinince kayıtları temizler (elle silinen oda / hub dahil) */
  function onChannelDelete(channel) {
    Q.delChannel.run(channel.id);
    Q.delHubByChannel.run(channel.id);
    renameAt.delete(channel.id);
  }

  /** Bot kapalıyken boşalmış / silinmiş odaları temizler (açılışta çağrılır) */
  async function cleanup() {
    for (const row of Q.allChannels.all()) {
      try {
        const guild = client.guilds.cache.get(row.guild_id);
        if (!guild?.available) continue;
        const channel = await guild.channels.fetch(row.channel_id).catch(() => null);
        if (!channel) {
          Q.delChannel.run(row.channel_id);
        } else if (humansIn(channel).size === 0) {
          await channel.delete('ChronoxVoice: açılış temizliği').catch(() => {});
        }
      } catch (err) {
        console.error('[chronoxvoice] temizlik:', err.message);
      }
    }
  }

  /* ════════════════════════════════════════════════════════════════════════
   *  KONTROL PANELİ (butonlar • modallar • seçim menüleri)
   * ════════════════════════════════════════════════════════════════════════ */
  function panelPayload() {
    const rows = [];
    for (let n = 0; n < BUTTONS.length; n += 5) {
      rows.push(
        new ActionRowBuilder().addComponents(
          BUTTONS.slice(n, n + 5).map(([id, emoji, label]) =>
            new ButtonBuilder().setCustomId(`tv:b:${id}`).setEmoji(emoji).setLabel(label).setStyle(id === 'delete' ? ButtonStyle.Danger : ButtonStyle.Secondary)
          )
        )
      );
    }
    const e = embed(
      COLOR.info,
      '🎙️ ChronoxVoice Arayüzü',
      'Bu arayüz, geçici ses odanı düzenlemek için kullanılabilir. Komut yazmana gerek yok: önce **➕ Oda Oluştur** kanalına girip kendi odanı aç, sonra aşağıdaki butonlara bas.\n\n' +
        '📝 Oda ismi • 👥 Kişi limiti • 🔒 Kilitle / aç • 👁️ Gizle / göster • 💬 Sohbeti aç / kapat\n' +
        '✅ Güvenilir ekle • ❎ Güvenilirden çıkar • 📨 Davet gönder • 👢 Sesten at • 🌐 Ses bölgesi\n' +
        '⛔ Engelle • 🔓 Engeli kaldır • 👑 Sahiplen • 🔄 Sahipliği devret • 🗑️ Odayı sil'
    ).setFooter({ text: 'Butonlar yalnızca bulunduğun odanın sahibi içindir.' });
    return { embeds: [e], components: rows };
  }

  async function sendPanel(channel) {
    const me = channel.guild.members.me ?? (await channel.guild.members.fetchMe());
    if (!channel.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) throw new Error('missing-perms');
    return channel.send(panelPayload());
  }

  /* ── Yanıt yardımcıları ───────────────────────────────────────────────── */
  const resultBody = (ok, text) => ({ embeds: [embed(ok ? COLOR.ok : COLOR.error, null, `${ok ? '✅' : '❌'} ${text}`)], components: [] });
  async function reply(i, ok, text) {
    const body = resultBody(ok, text);
    if (i.deferred || i.replied) return i.editReply(body);
    if (i.isAnySelectMenu()) return i.update(body); // seçim menüsü mesajını sonuçla değiştirir
    return i.reply({ ...body, flags: EPHEMERAL });
  }

  /** Tıklayan kişinin bulunduğu geçici oda + sahiplik kontrolü */
  function getCtx(i, { owner = true } = {}) {
    const vc = i.member?.voice?.channel;
    const row = vc ? Q.getChannel.get(vc.id) : null;
    if (!row) return { err: 'Bu butonu kullanmak için önce bir geçici ses odasının içinde olmalısın.' };
    if (owner && row.owner_id !== i.user.id) return { err: `Bu odanın sahibi <@${row.owner_id}>. Bu butonu yalnızca oda sahibi kullanabilir.` };
    return { vc, row };
  }

  function renameWait(channelId) {
    return Math.ceil(Math.max(0, RENAME_COOLDOWN_MS - (Date.now() - (renameAt.get(channelId) ?? 0))) / 1000);
  }

  const textInput = (id, label, extra) => new ActionRowBuilder().addComponents(extra(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true)));

  /* ── Buton tıklamaları ───────────────────────────────────────────────── */
  async function onButton(i, action) {
    if (action === 'claim') {
      const c = getCtx(i, { owner: false });
      if (c.err) return reply(i, false, c.err);
      if (c.row.owner_id === i.user.id) return reply(i, false, 'Zaten bu odanın sahibisin.');
      if (c.vc.members.has(c.row.owner_id)) return reply(i, false, `Oda sahibi (<@${c.row.owner_id}>) hâlâ odada, sahiplenemezsin.`);
      await setOwner(c.vc, c.row, i.user.id);
      return reply(i, true, 'Artık bu odanın sahibisin.');
    }

    const c = getCtx(i);
    if (c.err) return reply(i, false, c.err);
    const { vc, row } = c;
    const everyone = i.guild.roles.everyone;

    switch (action) {
      case 'name': {
        const wait = renameWait(vc.id);
        if (wait > 0) return reply(i, false, `Discord sınırları yüzünden oda adı en sık 5 dakikada bir değişebilir. ${wait} sn sonra tekrar dene.`);
        return i.showModal(
          new ModalBuilder().setCustomId('tv:m:name').setTitle('Oda İsmi').addComponents(
            textInput('name', 'Yeni oda ismi', (t) => t.setMinLength(1).setMaxLength(90).setValue(truncate(vc.name, 90)))
          )
        );
      }
      case 'limit':
        return i.showModal(
          new ModalBuilder().setCustomId('tv:m:limit').setTitle('Oda Limiti').addComponents(
            textInput('limit', 'Kişi limiti (0 = sınırsız, en fazla 99)', (t) => t.setMinLength(1).setMaxLength(2).setValue(String(vc.userLimit || 0)))
          )
        );
      case 'lock': {
        const locked = isDenied(vc, everyone.id, P.Connect);
        await vc.permissionOverwrites.edit(everyone, { Connect: locked ? null : false }, { reason: `ChronoxVoice: ${i.user.username}` });
        return reply(i, true, locked ? '🔓 Oda kilidi açıldı, herkes girebilir.' : '🔒 Oda kilitlendi. İçeridekiler kalır; yeni girişler için **✅ Güvenilir** veya **📨 Davet** kullan.');
      }
      case 'hide': {
        const hidden = isDenied(vc, everyone.id, P.ViewChannel);
        await vc.permissionOverwrites.edit(everyone, { ViewChannel: hidden ? null : false }, { reason: `ChronoxVoice: ${i.user.username}` });
        return reply(i, true, hidden ? '👁️ Oda artık herkese görünüyor.' : '🙈 Oda gizlendi; yalnızca içeridekiler ve güvenilir/davetli kişiler görebilir.');
      }
      case 'chat': {
        const off = isDenied(vc, everyone.id, P.SendMessages);
        await vc.permissionOverwrites.edit(everyone, { SendMessages: off ? null : false }, { reason: `ChronoxVoice: ${i.user.username}` });
        await vc.permissionOverwrites.edit(row.owner_id, { SendMessages: off ? null : true }, { reason: `ChronoxVoice: ${i.user.username}` });
        return reply(i, true, off ? '💬 Oda sohbeti açıldı.' : '🔇 Oda sohbeti kapatıldı (sen yazmaya devam edebilirsin).');
      }
      case 'region':
        return i.reply({
          embeds: [embed(COLOR.info, null, '🌐 Odanın **ses bölgesini** seç. (Ping sorunu yaşıyorsan bölgeyi değiştirmek işe yarar.)')],
          components: [
            new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder().setCustomId('tv:s:region').setPlaceholder('Bölge seç').addOptions(REGIONS.map(([value, label]) => ({ value, label })))
            ),
          ],
          flags: EPHEMERAL,
        });
      case 'delete':
        await reply(i, true, 'Oda siliniyor...');
        return vc.delete(`ChronoxVoice: ${i.user.username} sildi`);
      default:
        if (PICK_TEXT[action]) {
          return i.reply({
            embeds: [embed(COLOR.info, null, PICK_TEXT[action])],
            components: [
              new ActionRowBuilder().addComponents(
                new UserSelectMenuBuilder().setCustomId(`tv:s:${action}`).setPlaceholder('Kullanıcı seç').setMinValues(1).setMaxValues(1)
              ),
            ],
            flags: EPHEMERAL,
          });
        }
    }
  }

  /* ── Modal gönderimleri (isim / limit) ───────────────────────────────── */
  async function onModal(i, action) {
    const c = getCtx(i);
    if (c.err) return reply(i, false, c.err);
    const { vc } = c;

    if (action === 'name') {
      const name = i.fields.getTextInputValue('name').trim();
      if (!name) return reply(i, false, 'Geçerli bir isim yaz.');
      const wait = renameWait(vc.id);
      if (wait > 0) return reply(i, false, `Oda adı en sık 5 dakikada bir değişebilir. ${wait} sn sonra tekrar dene.`);
      await i.deferReply({ flags: EPHEMERAL });
      await vc.setName(truncate(name, 100), `ChronoxVoice: ${i.user.username}`);
      renameAt.set(vc.id, Date.now());
      return reply(i, true, `Oda ismi **${truncate(name, 100)}** olarak değiştirildi.`);
    }
    if (action === 'limit') {
      const raw = i.fields.getTextInputValue('limit').trim();
      const n = Number(raw);
      if (!/^\d{1,2}$/.test(raw) || !Number.isInteger(n) || n > 99) return reply(i, false, 'Limit 0 ile 99 arasında bir sayı olmalı.');
      await vc.setUserLimit(n, `ChronoxVoice: ${i.user.username}`);
      return reply(i, true, n ? `Oda limiti **${n}** kişi olarak ayarlandı.` : 'Oda limiti kaldırıldı (sınırsız).');
    }
  }

  /* ── Seçim menüleri (kullanıcı / bölge) ──────────────────────────────── */
  async function onSelect(i, action) {
    const c = getCtx(i);
    if (c.err) return reply(i, false, c.err);
    const { vc, row } = c;

    if (action === 'region') {
      const value = i.values[0];
      const region = REGIONS.find(([v]) => v === value);
      if (!region) return reply(i, false, 'Geçersiz bölge.');
      await vc.setRTCRegion(value === 'auto' ? null : value, `ChronoxVoice: ${i.user.username}`);
      return reply(i, true, `Ses bölgesi **${region[1]}** olarak ayarlandı.`);
    }
    if (!PICK_TEXT[action]) return;

    const target = await i.guild.members.fetch(i.values[0]).catch(() => null);
    if (!target) return reply(i, false, 'Bu kullanıcı sunucuda bulunamadı.');
    if (target.id === i.user.id) return reply(i, false, 'Bu işlemi kendin için yapamazsın.');
    const inRoom = target.voice.channelId === vc.id;
    const protectedMember = target.permissions.has(P.MoveMembers); // yetkililer atılamaz / engellenemez
    const reason = `ChronoxVoice: ${i.user.username}`;

    switch (action) {
      case 'trust':
        await vc.permissionOverwrites.edit(target.id, { ViewChannel: true, Connect: true }, { reason });
        return reply(i, true, `${target} güvenilir listene eklendi; oda kilitli olsa bile girebilir.`);
      case 'untrust': {
        if (!vc.permissionOverwrites.cache.get(target.id)?.allow.has(P.Connect)) return reply(i, false, `${target} güvenilir listende değil.`);
        await vc.permissionOverwrites.edit(target.id, { ViewChannel: null, Connect: null }, { reason });
        return reply(i, true, `${target} güvenilir listesinden çıkarıldı.`);
      }
      case 'invite': {
        if (target.user.bot) return reply(i, false, 'Botlar davet edilemez.');
        await vc.permissionOverwrites.edit(target.id, { ViewChannel: true, Connect: true }, { reason });
        const link = `https://discord.com/channels/${i.guild.id}/${vc.id}`;
        const sent = await target
          .send({ embeds: [embed(COLOR.info, '🎙️ Ses odası daveti', `${i.user} seni **${truncate(vc.name, 100)}** odasına davet etti.\n[Odaya katıl](${link})`)] })
          .then(() => true)
          .catch(() => false);
        return reply(i, true, sent ? `${target} kullanıcısına davet DM olarak gönderildi.` : `${target} için giriş izni verildi ama DM'i kapalı. Bağlantıyı kendin paylaşabilirsin: ${link}`);
      }
      case 'kick':
        if (protectedMember) return reply(i, false, 'Bu kullanıcı yetkili olduğu için odadan atılamaz.');
        if (!inRoom) return reply(i, false, `${target} şu an odanda değil.`);
        await target.voice.disconnect(reason);
        return reply(i, true, `${target} odadan atıldı.`);
      case 'ban':
        if (protectedMember) return reply(i, false, 'Bu kullanıcı yetkili olduğu için engellenemez.');
        await vc.permissionOverwrites.edit(target.id, { Connect: false }, { reason });
        if (inRoom) await target.voice.disconnect(reason);
        return reply(i, true, `${target} odadan engellendi ve tekrar giremez.`);
      case 'unban': {
        if (!isDenied(vc, target.id, P.Connect)) return reply(i, false, `${target} bu odada engelli değil.`);
        await vc.permissionOverwrites.edit(target.id, { Connect: null }, { reason });
        return reply(i, true, `${target} kullanıcısının engeli kaldırıldı.`);
      }
      case 'transfer':
        if (target.user.bot) return reply(i, false, 'Sahipliği bir bota devredemezsin.');
        if (!inRoom) return reply(i, false, 'Sahipliği yalnızca şu an odanın içinde olan birine devredebilirsin.');
        await setOwner(vc, row, target.id, { keepOldAccess: true });
        return reply(i, true, `Oda sahipliği ${target} kullanıcısına devredildi.`);
    }
  }

  /** index.js'in yönlendiricisi: customId "tv:" ile başlayan buton / modal / menü etkileşimleri */
  async function handleComponent(i) {
    const [, kind, action] = i.customId.split(':');
    try {
      if (kind === 'b') return await onButton(i, action);
      if (kind === 'm') return await onModal(i, action);
      if (kind === 's') return await onSelect(i, action);
    } catch (err) {
      console.error('[chronoxvoice:panel]', err);
      const msg = err?.code === 50013 || err?.code === 50001
        ? 'Botun bu işlem için yetkisi yok. Bot rolüne **Kanalları Yönet, Rolleri Yönet, Üyeleri Taşı** izinlerini ver.'
        : 'İşlem başarısız oldu, lütfen tekrar dene.';
      await reply(i, false, msg).catch(() => {});
    }
  }

  /* ── Yönetici komutu: /chronoxvoice ──────────────────────────────────────── */
  const chronoxvoiceCommand = {
    perm: P.ManageChannels,
    data: new SlashCommandBuilder()
      .setName('chronoxvoice')
      .setDescription('Geçici ses odası sistemini (kanala gir, odanı oluştur) ve kontrol panelini ayarlar')
      .addSubcommand((s) =>
        s
          .setName('setup')
          .setDescription('Oda oluşturma kanalını kurar ve butonlu kontrol panelini bu kanala gönderir')
          .addChannelOption((o) =>
            o.setName('channel').setDescription('Hub olarak kullanılacak mevcut ses kanalı (boşsa yeni açılır)').addChannelTypes(ChannelType.GuildVoice)
          )
          .addChannelOption((o) =>
            o.setName('category').setDescription('Odaların açılacağı kategori (boşsa hub\'ın kategorisi / yeni kategori)').addChannelTypes(ChannelType.GuildCategory)
          )
          .addChannelOption((o) =>
            o.setName('panel_channel').setDescription('Panelin gönderileceği metin kanalı (boşsa komutu yazdığın kanal)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          )
      )
      .addSubcommand((s) =>
        s
          .setName('panel')
          .setDescription('Butonlu kontrol panelini tekrar gönderir')
          .addChannelOption((o) =>
            o.setName('channel').setDescription('Panelin gönderileceği metin kanalı (boşsa komutu yazdığın kanal)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          )
      )
      .addSubcommand((s) =>
        s
          .setName('disable')
          .setDescription('Geçici ses odası sistemini kapatır')
          .addBooleanOption((o) => o.setName('delete_hub').setDescription('Oda oluşturma kanalı da silinsin mi?'))
      ),
    async execute(i) {
      const { guild } = i;
      const sub = i.options.getSubcommand();
      const current = Q.getHub.get(guild.id);

      if (sub === 'disable') {
        if (!current) return fail(i, 'Geçici ses odası sistemi zaten kapalı.');
        Q.delHub.run(guild.id);
        if (i.options.getBoolean('delete_hub')) {
          await guild.channels.cache.get(current.hub_id)?.delete('ChronoxVoice kapatıldı').catch(() => {});
        }
        return succeed(i, 'Geçici ses odası sistemi kapatıldı. Açık odalar boşalınca yine silinir. (Eski panel mesajını elle silebilirsin.)');
      }

      if (sub === 'panel') {
        if (!current) return fail(i, 'Önce `/chronoxvoice setup` ile sistemi kur.');
        const target = i.options.getChannel('channel') ?? i.channel;
        try {
          await sendPanel(target);
        } catch {
          return fail(i, `Panel ${target} kanalına gönderilemedi. Botun orada **Kanalı Görüntüle, Mesaj Gönder, Bağlantı Göm** izinleri olmalı.`);
        }
        return succeed(i, `Kontrol paneli ${target} kanalına gönderildi.`, true);
      }

      // setup
      const me = guild.members.me ?? (await guild.members.fetchMe());
      const missing = [
        [P.ManageChannels, 'Kanalları Yönet'],
        [P.ManageRoles, 'Rolleri Yönet'],
        [P.MoveMembers, 'Üyeleri Taşı'],
      ].filter(([flag]) => !me.permissions.has(flag)).map(([, name]) => name);
      if (missing.length) return fail(i, `Botta şu izinler eksik: **${missing.join(', ')}**.`);

      let hub = i.options.getChannel('channel');
      let category = i.options.getChannel('category');
      if (!hub && current && guild.channels.cache.has(current.hub_id)) {
        return fail(i, `Sistem zaten kurulu: <#${current.hub_id}>. Paneli yeniden göndermek için \`/chronoxvoice panel\`, hub'ı değiştirmek için \`channel\` seçeneğini kullan.`);
      }

      await i.deferReply({ flags: EPHEMERAL });
      if (!hub) {
        if (!category) {
          category = await guild.channels.create({ name: '🎙️ Özel Odalar', type: ChannelType.GuildCategory, reason: 'ChronoxVoice kurulumu' });
        }
        hub = await guild.channels.create({
          name: '➕ Oda Oluştur',
          type: ChannelType.GuildVoice,
          parent: category.id,
          reason: 'ChronoxVoice kurulumu',
        });
      }
      Q.setHub.run(guild.id, hub.id, category?.id ?? hub.parentId ?? null);

      const panelTarget = i.options.getChannel('panel_channel') ?? i.channel;
      let note;
      try {
        await sendPanel(panelTarget);
        note = `Kontrol paneli ${panelTarget} kanalına gönderildi.`;
      } catch {
        note = `⚠️ Panel ${panelTarget} kanalına gönderilemedi (botun **Mesaj Gönder / Bağlantı Göm** izni yok). İzni verip \`/chronoxvoice panel\` yazabilirsin.`;
      }
      return succeed(i, `Kurulum tamam! ${hub} kanalına giren herkes kendi ses odasını alır. ${note}`);
    },
  };

  return {
    commands: [chronoxvoiceCommand],
    handleVoiceState,
    handleComponent,
    onChannelDelete,
    cleanup,
    isManaged: (channelId) => Boolean(Q.getChannel.get(channelId)),
    isBusy: (guildId) => [...creating].some((k) => k.startsWith(`${guildId}:`)),
  };
};
