import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import 'dotenv/config';

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Supabase Admin Client
  const supabaseAdmin = createClient(
    process.env.VITE_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  );

  // API Route: Create User (Admin Only)
  app.post("/api/admin/create-user", async (req, res) => {
    const { email, password, role, adminEmail } = req.body;

    // Basic security check: Only allow if caller claims to be the main admin
    // In a real app, you'd check the JWT token from the request
    if (adminEmail !== "admin@xbfa.com") {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      // 1. Create Auth User
      const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true // Auto confirm
      });

      if (authError) throw authError;

      // 2. Set Role in user_roles
      const { error: roleError } = await supabaseAdmin.from('user_roles').upsert([
        { user_id: authUser.user.id, role }
      ]);

      if (roleError) throw roleError;

      // 3. Create Profile
      const { error: profileError } = await supabaseAdmin.from('profiles').upsert([
        { id: authUser.user.id, username: email, role }
      ]);

      if (profileError) throw profileError;

      res.json({ message: "User created successfully", user: authUser.user });
    } catch (error: any) {
      console.error("Admin user creation error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
