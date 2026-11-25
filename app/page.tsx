export const dynamic = "force-static";

export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "8rem auto", padding: "0 1rem" }}>
      <h1>DDICBot</h1>
      <p>
        药物相互作用查询 Bot · Drug–drug interaction checker
      </p>
      <p>
        The bot runs on Telegram (<code>/check &lt;drug1&gt; &lt;drug2&gt;</code>).
        This URL itself only serves the webhook at{" "}
        <code>/api/tg-webhook</code>.
      </p>
      <p style={{ color: "#666" }}>
        🚨 紧急情况请拨打当地急救电话（中国大陆 120 / 美国 911 / 日本 119）。
        <br />
        ⚕️ 数据库检索仅供信息参考，非医疗建议。Database lookup only — not medical advice.
      </p>
    </main>
  );
}
