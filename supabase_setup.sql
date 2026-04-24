-- 1. Create a table for user roles
CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'visitor'
);

-- 2. Create a profiles table for user management
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  username TEXT UNIQUE,
  role TEXT DEFAULT 'visitor',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 3. Enable Row Level Security
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 3.1 Enable RLS for data tables
ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.awards ENABLE ROW LEVEL SECURITY;

-- 3.2 Add Policies for ALL authenticated users (Simplified for now)
-- In a real app, you'd restrict INSERT/UPDATE/DELETE to 'admin' role
-- but matching user intent to allow all authenticated users for now.

-- Players
CREATE POLICY "Allow all for authenticated users" ON public.players FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow select for everyone" ON public.players FOR SELECT TO public USING (true);

-- Matches
CREATE POLICY "Allow all for authenticated users" ON public.matches FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow select for everyone" ON public.matches FOR SELECT TO public USING (true);

-- Seasons
CREATE POLICY "Allow all for authenticated users" ON public.seasons FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow select for everyone" ON public.seasons FOR SELECT TO public USING (true);

-- Match Ratings
CREATE POLICY "Allow all for authenticated users" ON public.match_ratings FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow select for everyone" ON public.match_ratings FOR SELECT TO public USING (true);

-- Awards
CREATE POLICY "Allow all for authenticated users" ON public.awards FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow select for everyone" ON public.awards FOR SELECT TO public USING (true);

-- Profiles & User Roles
CREATE POLICY "Allow users to read their own role" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Allow users to read profiles" ON public.profiles FOR SELECT TO authenticated USING (true);

-- 4. Create a function to handle new user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- Insert into user_roles
  INSERT INTO public.user_roles (user_id, role)
  VALUES (new.id, 'visitor');

  -- Insert into profiles
  INSERT INTO public.profiles (id, username, role)
  VALUES (new.id, new.email, 'visitor');

  RETURN new;
END;
$$;

-- 5. Create a trigger to run after a new user is created in auth.users
CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
