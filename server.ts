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
    const { email, password, role, adminToken } = req.body;

    if (!email || !password || !role) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    try {
      // 1. Verify the caller is an admin using Supabase
      // We use the token sent from the frontend to identify the user
      const { data: { user: adminUser }, error: verifyError } = await supabaseAdmin.auth.getUser(adminToken);
      
      if (verifyError || !adminUser) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Check if this user is allowed to be an admin
      // Hardcoded master admin OR check user_roles table
      const { data: roleData } = await supabaseAdmin
        .from('user_roles')
        .select('role')
        .eq('user_id', adminUser.id)
        .single();

      const isAdmin = adminUser.email === "admin@xbfa.com" || (roleData && roleData.role === 'admin');

      if (!isAdmin) {
        return res.status(403).json({ error: "Forbidden: Admin access required" });
      }

      // 2. Create Auth User
      const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true // Skip email confirmation
      });

      if (authError) throw authError;

      const newUser = authUser.user;

      // 3. Set Role in user_roles (Upsert to overwrite trigger default if any)
      const { error: roleError } = await supabaseAdmin.from('user_roles').upsert({
        user_id: newUser.id,
        role: role
      });

      if (roleError) throw roleError;

      // 4. Create/Update Profile
      const { error: profileError } = await supabaseAdmin.from('profiles').upsert({
        id: newUser.id,
        username: email,
        role: role
      });

      if (profileError) throw profileError;

      res.json({ message: "User created successfully", user: newUser });
    } catch (error: any) {
      console.error("Admin user creation error:", error);
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  });

  // API Route: Update User Password (Admin Only)
  app.post("/api/admin/update-user-password", async (req, res) => {
    const { userId, newPassword, adminToken } = req.body;

    try {
      const { data: { user: adminUser }, error: verifyError } = await supabaseAdmin.auth.getUser(adminToken);
      if (verifyError || !adminUser) return res.status(401).json({ error: "Unauthorized" });

      const { data: roleData } = await supabaseAdmin.from('user_roles').select('role').eq('user_id', adminUser.id).single();
      const isAdmin = adminUser.email === "admin@xbfa.com" || (roleData && roleData.role === 'admin');
      if (!isAdmin) return res.status(403).json({ error: "Forbidden" });

      const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(userId, { password: newPassword });
      if (authError) throw authError;

      res.json({ message: "Password updated successfully" });
    } catch (error: any) {
      console.error("Admin password update error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // API Route: Delete User (Admin Only)
  app.post("/api/admin/delete-user", async (req, res) => {
    const { userId, adminToken } = req.body;

    try {
      const { data: { user: adminUser }, error: verifyError } = await supabaseAdmin.auth.getUser(adminToken);
      if (verifyError || !adminUser) return res.status(401).json({ error: "Unauthorized" });

      const { data: roleData } = await supabaseAdmin.from('user_roles').select('role').eq('user_id', adminUser.id).single();
      const isAdmin = adminUser.email === "admin@xbfa.com" || (roleData && roleData.role === 'admin');
      if (!isAdmin) return res.status(403).json({ error: "Forbidden" });

      const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (authError) throw authError;

      // Note: user_roles and profiles will be deleted by ON DELETE CASCADE if set up correctly
      // In our SQL, we have REFERENCES auth.users ON DELETE CASCADE

      res.json({ message: "User deleted successfully" });
    } catch (error: any) {
      console.error("Admin user delete error:", error);
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
