const T = {
  sv: {
    subject: (site) => `Svar från ${site}`,
    intro: 'Hej! Här är vårt svar på ditt meddelande:',
    footer: (url) => `Du kan fortsätta konversationen i chatten${url ? `: ${url}` : ' på vår webbplats'}.`,
    note: 'Meddelandet har översatts automatiskt.',
  },
  fi: {
    subject: (site) => `Vastaus: ${site}`,
    intro: 'Hei! Tässä vastauksemme viestiisi:',
    footer: (url) => `Voit jatkaa keskustelua chatissa${url ? `: ${url}` : ' verkkosivuillamme'}.`,
    note: 'Viesti on käännetty automaattisesti.',
  },
  da: {
    subject: (site) => `Svar fra ${site}`,
    intro: 'Hej! Her er vores svar på din besked:',
    footer: (url) => `Du kan fortsætte samtalen i chatten${url ? `: ${url}` : ' på vores hjemmeside'}.`,
    note: 'Beskeden er oversat automatisk.',
  },
  en: {
    subject: (site) => `Reply from ${site}`,
    intro: 'Hi! Here is our reply to your message:',
    footer: (url) => `You can continue the conversation in the chat${url ? `: ${url}` : ' on our website'}.`,
    note: 'This message was translated automatically.',
  },
  tr: {
    subject: (site) => `${site} yanıtı`,
    intro: 'Merhaba! Mesajınıza yanıtımız:',
    footer: (url) => `Sohbete sitemizdeki chat üzerinden devam edebilirsiniz${url ? `: ${url}` : ''}.`,
    note: '',
  },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * @param {{ lang: string, siteName: string, pageUrl?: string, lines: {author: string, text: string}[], translated: boolean }} p
 */
export function renderReplyEmail({ lang, siteName, pageUrl, lines, translated }) {
  const t = T[lang] || T.en;
  const subject = t.subject(siteName);
  const body = lines.map((l) => `${l.author}:\n${l.text}`).join('\n\n');
  const text = [t.intro, '', body, '', t.footer(pageUrl), translated && t.note ? `\n${t.note}` : ''].join('\n');
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#12302F;line-height:1.5;max-width:560px">
<p>${esc(t.intro)}</p>
${lines.map((l) => `<p style="margin:16px 0;padding:12px 16px;background:#F4F7F6;border-radius:10px"><b>${esc(l.author)}</b><br>${esc(l.text).replace(/\n/g, '<br>')}</p>`).join('\n')}
<p>${esc(t.footer('')).replace(/\.$/, '')}${pageUrl ? `: <a href="${esc(pageUrl)}">${esc(pageUrl)}</a>` : ''}.</p>
${translated && t.note ? `<p style="color:#6B7F7C;font-size:12px">${esc(t.note)}</p>` : ''}
</body></html>`;
  return { subject, text, html };
}
