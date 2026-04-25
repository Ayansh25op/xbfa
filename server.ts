import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import 'dotenv/config';

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Supabase Admin Client
  const supabaseAdmin = createClient(
    process.env.VITE_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  );

  // API Route: Create User (Admin Only)
  app.post("/api/admin/create-user", async (req, res) => {
    console.log("POST /api/admin/create-user - Request Body:", req.body);
    const { email, password, role, adminToken } = req.body;

    if (!email || !password || !role) {
      console.error("Missing fields:", { email, password: !!password, role });
      return res.status(400).json({ error: "Missing required fields" });
    }

    try {
      // 1. Verify the caller is an admin using Supabase
      const { data: { user: adminUser }, error: verifyError } = await supabaseAdmin.auth.getUser(adminToken);
      
      if (verifyError || !adminUser) {
        console.error("Verification error:", verifyError);
        return res.status(401).json({ error: "Unauthorized" });
      }

      console.log("Admin user verified:", adminUser.email);

      // Check if this user is allowed to be an admin
      const { data: roleData } = await supabaseAdmin
        .from('user_roles')
        .select('role')
        .eq('user_id', adminUser.id)
        .single();

      const isAdmin = adminUser.email === "admin@xbfa.com" || (roleData && roleData.role === 'admin');

      if (!isAdmin) {
        console.error("User is not an admin:", adminUser.email);
        return res.status(403).json({ error: "Forbidden: Admin access required" });
      }

      // 2. Create Auth User
      console.log("Creating new user in Supabase Auth...");
      const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true // Skip email confirmation
      });

      if (authError) {
        console.error("Auth creation error:", authError);
        throw authError;
      }

      const newUser = authUser.user;
      console.log("New user created successfully:", newUser.id);

      // 3. Set Role in user_roles
      const { error: roleError } = await supabaseAdmin.from('user_roles').upsert({
        user_id: newUser.id,
        role: role
      });

      if (roleError) {
        console.error("Role assignment error:", roleError);
        throw roleError;
      }

      // 4. Create/Update Profile
      const { error: profileError } = await supabaseAdmin.from('profiles').upsert({
        id: newUser.id,
        username: email,
        role: role
      });

      if (profileError) {
        console.error("Profile creation error:", profileError);
        throw profileError;
      }

      console.log("User management completion successful.");
      res.json({ message: "User created successfully", user: newUser });
    } catch (error: any) {
      console.error("Admin user creation error (catch):", error);
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  });

  // API Route: Update User Password (Admin Only)
  app.post("/api/admin/update-user-password", async (req, res) => {
    console.log("POST /api/admin/update-user-password - Request Body:", req.body);
    const { userId, newPassword, adminToken } = req.body;

    try {
      const { data: { user: adminUser }, error: verifyError } = await supabaseAdmin.auth.getUser(adminToken);
      if (verifyError || !adminUser) {
        console.error("Verification error:", verifyError);
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { data: roleData } = await supabaseAdmin.from('user_roles').select('role').eq('user_id', adminUser.id).single();
      const isAdmin = adminUser.email === "admin@xbfa.com" || (roleData && roleData.role === 'admin');
      if (!isAdmin) {
        console.error("User is not an admin:", adminUser.email);
        return res.status(403).json({ error: "Forbidden" });
      }

      console.log("Updating password for user:", userId);
      const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(userId, { password: newPassword });
      if (authError) {
        console.error("Auth password update error:", authError);
        throw authError;
      }

      res.json({ message: "Password updated successfully" });
    } catch (error: any) {
      console.error("Admin password update error (catch):", error);
      res.status(500).json({ error: error.message });
    }
  });

  // API Route: Delete User (Admin Only)
  app.post("/api/admin/delete-user", async (req, res) => {
    console.log("POST /api/admin/delete-user - Request Body:", req.body);
    const { userId, adminToken } = req.body;

    try {
      const { data: { user: adminUser }, error: verifyError } = await supabaseAdmin.auth.getUser(adminToken);
      if (verifyError || !adminUser) {
        console.error("Verification error:", verifyError);
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { data: roleData } = await supabaseAdmin.from('user_roles').select('role').eq('user_id', adminUser.id).single();
      const isAdmin = adminUser.email === "admin@xbfa.com" || (roleData && roleData.role === 'admin');
      if (!isAdmin) {
        console.error("User is not an admin:", adminUser.email);
        return res.status(403).json({ error: "Forbidden" });
      }

      console.log("Deleting user:", userId);
      const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (authError) {
        console.error("Auth delete error:", authError);
        throw authError;
      }

      res.json({ message: "User deleted successfully" });
    } catch (error: any) {
      console.error("Admin user delete error (catch):", error);
      res.status(500).json({ error: error.message });
    }
  });

  // 404 handler for /api routes
  app.use("/api/*", (req, res) => {
    res.status(404).json({ error: `API route ${req.method} ${req.originalUrl} not found` });
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
