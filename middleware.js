import { rewrite } from "@vercel/functions";

const BOT =
  /Twitterbot|TelegramBot|WebpageBot|facebookexternalhit|Facebot|Slackbot|Slack-ImgProxy|Discordbot|WhatsApp|LinkedInBot|Pinterest|Googlebot|Google-InspectionTool|bingbot|Embedly|Iframely|redditbot|Applebot|SkypeUriPreview|vkShare|BitlyBot|Snapchat|Viber/i;

export const config = {
  matcher: ["/", "/index.html", "/t/:path*"],
};

export default function middleware(request) {
  const ua = request.headers.get("user-agent") || "";
  if (!BOT.test(ua)) return;
  const url = new URL(request.url);
  const dest = new URL("/api/share", request.url);
  const m = url.pathname.match(/^\/t\/([^/]+)/i);
  if (m) dest.searchParams.set("t", decodeURIComponent(m[1]));
  return rewrite(dest);
}
