// Cloudflare Worker: ตรวจสลิปโดเนท TrippleNCJ ผ่าน SlipOK
// Secrets (wrangler secret put): SLIPOK_API_KEY
// Vars (wrangler.toml):          SLIPOK_BRANCH_ID, RECEIVER_KEYWORD, ALLOWED_ORIGIN
// KV binding:                    DONATIONS

const MAX_FILE = 5 * 1024 * 1024; // 5MB

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "https://tripplencj.online",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(env) },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors(env) });
    }
    if (url.pathname !== "/api/verify-slip" || request.method !== "POST") {
      return json(env, { ok: false, message: "Not found" }, 404);
    }

    // 1) รับข้อมูลจากฟอร์ม
    let form;
    try {
      form = await request.formData();
    } catch {
      return json(env, { ok: false, message: "ข้อมูลไม่ถูกต้อง" }, 400);
    }

    const slip = form.get("slip");
    const amount = Number(form.get("amount"));
    const name = String(form.get("name") || "").trim().slice(0, 50) || "ไม่ระบุชื่อ";
    const message = String(form.get("message") || "").trim().slice(0, 300);

    if (!(slip instanceof File)) {
      return json(env, { ok: false, message: "กรุณาแนบรูปสลิป" }, 400);
    }
    if (!slip.type.startsWith("image/") || slip.size > MAX_FILE) {
      return json(env, { ok: false, message: "ไฟล์ต้องเป็นรูปภาพ ขนาดไม่เกิน 5MB" }, 400);
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return json(env, { ok: false, message: "จำนวนเงินไม่ถูกต้อง" }, 400);
    }

    // 2) ส่งสลิปให้ SlipOK ตรวจกับธนาคาร
    const fd = new FormData();
    fd.append("files", slip, "slip.jpg");
    fd.append("amount", String(amount));
    fd.append("log", "true"); // ให้ SlipOK เช็กสลิปซ้ำให้ด้วย

    let res, result;
    try {
      res = await fetch(
        `https://api.slipok.com/api/line/apikey/${env.SLIPOK_BRANCH_ID}`,
        { method: "POST", headers: { "x-authorization": env.SLIPOK_API_KEY }, body: fd }
      );
      result = await res.json();
    } catch {
      return json(env, { ok: false, message: "ระบบตรวจสลิปไม่ตอบสนอง ลองใหม่อีกครั้ง" }, 502);
    }

    if (!res.ok || !result.success || !result.data) {
      // ตัวอย่าง: สลิปซ้ำ, อ่านสลิปไม่ได้, ยอดไม่ตรง
      return json(
        env,
        { ok: false, message: result.message || "ตรวจสอบสลิปไม่ผ่าน" },
        422
      );
    }

    const d = result.data;

    // 3) ตรวจเองซ้ำ: ยอดตรง + ผู้รับเป็นบัญชีของเรา
    if (Number(d.amount) !== amount) {
      return json(env, { ok: false, message: "ยอดในสลิปไม่ตรงกับที่ระบุ" }, 422);
    }

    const receiverText = JSON.stringify(d.receiver || {}).toLowerCase();
    const keyword = (env.RECEIVER_KEYWORD || "").toLowerCase();
    if (keyword && !receiverText.includes(keyword)) {
      return json(env, { ok: false, message: "สลิปนี้ไม่ได้โอนเข้าบัญชีของเรา" }, 422);
    }

    // 4) กันสลิปซ้ำอีกชั้นด้วย transRef
    const ref = d.transRef;
    if (!ref) {
      return json(env, { ok: false, message: "อ่านเลขอ้างอิงสลิปไม่ได้" }, 422);
    }
    if (await env.DONATIONS.get(`slip:${ref}`)) {
      return json(env, { ok: false, message: "สลิปนี้ถูกใช้ไปแล้ว" }, 409);
    }

    // 5) บันทึกโดเนท
    const record = {
      name,
      message,
      amount,
      transRef: ref,
      createdAt: new Date().toISOString(),
    };
    await env.DONATIONS.put(`slip:${ref}`, "1");
    await env.DONATIONS.put(`donation:${record.createdAt}:${ref}`, JSON.stringify(record));

    return json(env, { ok: true, name, amount });
  },
};
