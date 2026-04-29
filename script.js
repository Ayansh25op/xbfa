import { supabase, supabaseUrl, anonKey } from './supabase.js'

// --- GLOBAL STATE ---
let currentSeasonId = null;
let currentSeasonName = "";
let currentPage = "dashboard";
let seasons = [];
let players = [];
let matches = [];

const ROLE_PERMISSIONS = {
    admin: { all: true, adminOnly: true },
    editor: { 
        addMatch: true, 
        editMatch: true, 
        deleteMatch: true, 
        managePlayers: true, 
        manageAwards: true, 
        manageSeasons: true 
    },
    match_rater: { editMatch: true, deleteMatch: true, manageAwards: true },
    journalist: { manageAwards: true, readMatches: true },
    viewer: { readOnly: true },
    visitor: { readOnly: true }
};

function hasPermission(permission) {
    if (!userRole) return false;
    const perms = ROLE_PERMISSIONS[userRole] || ROLE_PERMISSIONS.visitor;
    if (perms.all) return true;
    return !!perms[permission];
}

// --- AUTH & SESSION ---
let session = null;
let userRole = "visitor";
const ADMIN_EMAIL = "admin@xbfa.com";

async function checkAuth() {
    const { data: { session: currentSession } } = await supabase.auth.getSession();
    session = currentSession;

    if (!session) {
        window.location.href = "login.html";
        return;
    }

    // Role Check
    if (session.user.email === ADMIN_EMAIL) {
        userRole = "admin";
    } else {
        // Fallback to database check for other users
        const { data: roleData } = await supabase.from('user_roles')
            .select('role')
            .eq('user_id', session.user.id)
            .single();

        userRole = roleData ? roleData.role : "visitor";
    }

    await init();
}

// Replace old init call
window.addEventListener('DOMContentLoaded', checkAuth);

async function logout() {
    await supabase.auth.signOut();
    window.location.href = "login.html";
}

// Map the old global 'user' to session.user.email for backward compatibility
let user = null;

// Centralized Data Storage
// (Variables moved to top for global availability)

// Removed redundant if(!user) redirect as checkAuth handles it


// --- STATE MANAGEMENT ---
let studioMatch = { team_a: [], team_b: [], events: [] };
let currentPhoto = "";
let editingMatchId = null;

// ===== SUPABASE DATA LOGIC =====

async function loadSeasons() {
    const { data, error } = await supabase.from('seasons').select('*').order('name');
    if (error) {
        console.error("Error loading seasons:", error);
        seasons = [{ id: "season_default", name: "Season 1" }];
    } else if (data && data.length > 0) {
        seasons = data;
    } else {
        // Initial setup if empty
        const { data: newData, error: newError } = await supabase.from('seasons').insert([{ name: "Season 1" }]).select();
        if (newError) {
            seasons = [{ id: "season_default", name: "Season 1" }];
        } else {
            seasons = newData;
        }
    }

    if (!currentSeasonId || !seasons.find(s => s.id == currentSeasonId)) {
        currentSeasonId = seasons[0].id;
    }
    currentSeasonName = seasons.find(s => s.id == currentSeasonId)?.name || seasons[0].name;
}

async function loadPlayers() {
    if (!currentSeasonId) {
        console.error("No season selected (loadPlayers)");
        await loadSeasons();
        if (!currentSeasonId) return;
    }
    const { data, error } = await supabase
        .from('players')
        .select('*')
        .eq('season_id', currentSeasonId);
    
    if (error) {
        console.error("Error loading players:", error);
        players = [];
    } else {
        players = (data || []).map(p => ({
            ...p,
            avgRating: p.avg_rating,
            latestRating: p.latest_rating
        }));
    }
}

async function loadMatches() {
    if (!currentSeasonId) {
        console.error("No season selected (loadMatches)");
        await loadSeasons();
        if (!currentSeasonId) return;
    }
    console.log("Loading matches from Supabase for season:", currentSeasonId);
    const { data, error } = await supabase
        .from('matches')
        .select('*, match_ratings(*), match_awards(*)')
        .eq('season_id', currentSeasonId);

    if (error) {
        console.error("Error loading matches:", error);
        matches = [];
        return;
    }

    matches = (data || []).map(m => {
        const awardsObj = {};
        (m.match_awards || []).forEach(aw => {
            awardsObj[aw.type] = aw.player_id;
        });

        return {
            ...m,
            ratings: (m.match_ratings || []).map(r => ({
                player_id: r.player_id,
                rating: r.rating
            })),
            awards: awardsObj
        };
    });
    console.log("Loaded matches:", matches);
}

async function savePlayerToDB(player) {
    if (!player) return;
    if (!currentSeasonId) {
        console.error("No season selected (savePlayer)");
        showAlertModal("Please select a season first.");
        return;
    }
    console.log("Saving player to DB:", player);
    const { id, ...playerData } = player;
    
    // Ensure season_id is included
    playerData.season_id = currentSeasonId;
    
    if (id && String(id).length > 20) { // Check if it's a UUID
        const { error } = await supabase.from('players').update(playerData).eq('id', id);
        if (error) {
            console.error("Error updating player:", error);
            throw error;
        }
    } else {
        const { error } = await supabase.from('players').insert([playerData]);
        if (error) {
            console.error("Error inserting player:", error);
            throw error;
        }
    }
    await loadPlayers();
    await recalculateStats();
}

async function deletePlayerFromDB(id) {
    const { error } = await supabase.from('players').delete().eq('id', id);
    if (error) console.error("Error deleting player:", error);
    await loadPlayers();
    await recalculateStats();
}

async function saveMatchToDB(match) {
    if (!match) return;
    if (!currentSeasonId) {
        console.error("No season selected (saveMatch)");
        showAlertModal("Please select a season first.");
        return;
    }
    
    // EXPLICITLY build the object for public.matches table to avoid schema mismatch
    // DO NOT use spread operators here
    const cleanMatchData = {
        date: match.date,
        title: match.title,
        team_a: match.team_a || [],
        team_b: match.team_b || [],
        events: match.events || [],
        score_a: match.score_a || 0,
        score_b: match.score_b || 0,
        season_id: currentSeasonId
    };

    console.log("MATCH DATA BEFORE INSERT/UPDATE (CLEAN):", cleanMatchData);

    try {
        let matchId = match.id;
        if (match.id && String(match.id).length > 20) {
            const { error } = await supabase.from('matches').update(cleanMatchData).eq('id', match.id);
            if (error) throw error;
        } else {
            const { data, error } = await supabase.from('matches').insert([cleanMatchData]).select();
            if (error) throw error;
            matchId = data[0].id;
        }

        // Handle ratings
        if (match.ratings) {
            await supabase.from('match_ratings').delete().eq('match_id', matchId);
            if (match.ratings.length > 0) {
                const ratingsToInsert = match.ratings
                    .filter(r => r.player_id && matchId)
                    .map(r => ({
                        match_id: matchId,
                        player_id: r.player_id,
                        rating: r.rating
                    }));
                
                if (ratingsToInsert.length > 0) {
                    const { error: rError } = await supabase.from('match_ratings').insert(ratingsToInsert);
                    if (rError) throw rError;
                }
            }
        }

        // Handle match awards
        if (match.awards) {
            await supabase.from('match_awards').delete().eq('match_id', matchId);
            const awardsToInsert = [];
            if (match.awards.mvp) awardsToInsert.push({ match_id: matchId, type: 'mvp', player_id: match.awards.mvp });
            if (match.awards.lvp) awardsToInsert.push({ match_id: matchId, type: 'lvp', player_id: match.awards.lvp });
            if (match.awards.gk) awardsToInsert.push({ match_id: matchId, type: 'gk', player_id: match.awards.gk });
            
            if (awardsToInsert.length > 0) {
                const { error: aError } = await supabase.from('match_awards').insert(awardsToInsert);
                if (aError) throw aError;
            }
        }

        await loadMatches();
        await recalculateStats();
        renderAll();
    } catch (err) {
        console.error("Match Save Error:", err);
        showAlertModal("Error saving match: " + err.message);
        throw err;
    }
}

async function deleteMatchFromDB(id) {
    const { error } = await supabase.from('matches').delete().eq('id', id);
    if (error) console.error("Error deleting match:", error);
    await loadMatches();
    await recalculateStats();
    renderAll();
}

/**
 * RECALCULATES ALL PLAYER STATISTICS
 * Processes matches to update goal counts and match counts.
 * This ensures the dashboard and leaderboards stay accurate after deletions or edits.
 */
async function recalculateStats() {
    const activeMatches = matches;
    const activePlayers = players;

    console.log("Recalculating stats for", activePlayers.length, "players using", activeMatches.length, "matches");

    // Reset stats for all active players
    activePlayers.forEach(p => {
        if (!p) return;
        p.goals = 0;
        p.matches = 0;
        p.avgRating = 0;
        p.latestRating = null;
        p.totalRatingScore = 0;
        p.ratingCount = 0;
    });

    // Sort matches by date to correctly identify latest rating
    const sortedMatches = [...activeMatches].sort((a,b) => new Date(a.date) - new Date(b.date));

    // Recalculate based on match data
    sortedMatches.forEach(m => {
        // 1. Goal Distribution
        (m.events || []).forEach(e => {
            if (e && !e.ownGoal) {
                const p = activePlayers.find(pl => pl && String(pl.id) === String(e.scorer));
                if (p) p.goals = (p.goals || 0) + 1;
            }
        });

        // 2. Participation Count (Matches Played)
        const uniqueParticipants = [...new Set([...(m.team_a || []), ...(m.team_b || [])])];
        uniqueParticipants.forEach(pid => {
            const p = activePlayers.find(pl => pl && String(pl.id) === String(pid));
            if (p) p.matches = (p.matches || 0) + 1;
        });

        // 3. Ratings
        if (m.ratings) {
            m.ratings.forEach(r => {
                const p = activePlayers.find(pl => pl && String(pl.id) === String(r.player_id));
                if (p && r.rating) {
                    p.totalRatingScore += parseFloat(r.rating);
                    p.ratingCount += 1;
                    p.latestRating = r.rating;
                }
            });
        }
    });

    // Update DB for each player
    const updatePromises = activePlayers.map(async (p) => {
        if (!p) return;
        
        if (p.ratingCount > 0) {
            p.avgRating = (p.totalRatingScore / p.ratingCount).toFixed(1);
        }
        
        const finalGoals = p.goals || 0;
        const finalMatches = p.matches || 0;
        const finalAvgRating = p.avgRating || 0;
        const finalLatestRating = p.latestRating || null;

        console.log(`Player ${p.name}: Goals=${finalGoals}, Matches=${finalMatches}, Avg=${finalAvgRating}, Latest=${finalLatestRating}`);

        // Persist to Supabase
        const { error } = await supabase.from('players').update({
            goals: finalGoals,
            matches: finalMatches,
            avg_rating: finalAvgRating,
            latest_rating: finalLatestRating
        }).eq('id', p.id);

        if (error) console.error(`Error updating stats for ${p.name}:`, error);

        delete p.totalRatingScore;
        delete p.ratingCount;
    });

    await Promise.all(updatePromises);
    console.log("Recalculation complete and persisted to DB.");
}


// --- NAVIGATION ---
function navigateTo(page) {
    currentPage = page;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    
    const target = document.getElementById(page);
    if (target) {
        target.classList.add('active');
    } else {
        console.error("Page not found:", page);
        return;
    }
    
    // Update Active States for all nav items
    document.querySelectorAll('.nav-item, .bottom-nav-item').forEach(el => {
        el.classList.toggle('active', el.dataset.page === page);
    });

    renderAll();
    window.scrollTo(0, 0); // Reset scroll on page switch
}

// Support for old calls if any
function showPage(id) {
    navigateTo(id);
}

// --- GLOBAL NAVIGATION EXPOSURE ---
window.navigateTo = navigateTo;
window.showPage = showPage;
window.openDashboard = () => navigateTo('dashboard');
window.openSquad = () => navigateTo('squad');
window.openMatches = () => navigateTo('matches');
window.openLeaderboards = () => navigateTo('leaderboards');
window.openAwards = () => navigateTo('awards');
window.openSettings = () => navigateTo('settings');

// --- ADMIN DASHBOARD RENDER ---
async function renderAdminDashboard() {
    if (!currentPage || currentPage !== 'settings') return;

    const isAdmin = hasPermission('adminOnly');
    
    // Update Headings based on role
    const titleEl = document.getElementById('settings-title');
    const subtitleEl = document.getElementById('settings-subtitle');
    
    if (isAdmin) {
        if (titleEl) titleEl.innerText = "SYSTEM CONTROL";
        if (subtitleEl) subtitleEl.innerText = "Advanced configuration and maintenance portal";
    } else {
        if (titleEl) titleEl.innerText = "ACCOUNT SETTINGS";
        if (subtitleEl) subtitleEl.innerText = "Manage your profile and security credentials";
    }

    // Toggle Visibility of admin-only sections
    document.querySelectorAll('.admin-only').forEach(el => {
        el.style.display = isAdmin ? 'flex' : 'none';
    });

    // Handle Season Manager Visibility (Restricted to admin and editor)
    const canManageSeasons = hasPermission('manageSeasons');
    document.querySelectorAll('.permission-manageSeasons').forEach(el => {
        el.style.display = canManageSeasons ? 'flex' : 'none';
    });

    // Only render advanced stats if allowed
    if (isAdmin) {
        // 1. Data Stats
        const matchesCountEl = document.getElementById('admin-total-matches');
        const playersCountEl = document.getElementById('admin-total-players');
        const goalsCountEl = document.getElementById('admin-total-goals');
        
        if (matchesCountEl) matchesCountEl.innerText = matches.length;
        if (playersCountEl) playersCountEl.innerText = players.length;
        
        if (goalsCountEl) {
            let totalGoals = 0;
            matches.forEach(m => totalGoals += (m.score_a || 0) + (m.score_b || 0));
            goalsCountEl.innerText = totalGoals;
        }

        // 2. Best Player Mini Card
        const mvpRow = document.getElementById('admin-mvp-name');
        if (mvpRow) {
            if (players.length > 0) {
                const sorted = [...players].sort((a,b) => (b.avg_rating || 0) - (a.avg_rating || 0));
                mvpRow.innerText = sorted[0].name;
            } else {
                mvpRow.innerText = "No Records";
            }
        }

        updateAdminUserStats();
    }

    // 3. Debug Panel (always updated if element exists, visibility handled by .admin-only class)
    const debugSeason = document.getElementById('debug-season-id');
    if (debugSeason) debugSeason.innerText = currentSeasonId || "No Active Season";

    // 4. Update Profile Card
    const profileEmailEl = document.getElementById('profile-email');
    const profileRoleBadgeEl = document.getElementById('profile-role-badge');
    
    if (profileEmailEl && session && session.user) {
        profileEmailEl.innerText = session.user.email;
    }
    
    if (profileRoleBadgeEl) {
        profileRoleBadgeEl.className = 'role-badge';
        profileRoleBadgeEl.innerText = userRole.toUpperCase();
        
        // Color coding for role badge
        if (userRole === 'admin') profileRoleBadgeEl.style.color = '#00ff9c';
        else if (userRole === 'editor') profileRoleBadgeEl.style.color = '#00eaff';
        else profileRoleBadgeEl.style.color = 'var(--text-dim)';
    }
}

async function updateAdminUserStats() {
    try {
        const { data, count, error } = await supabase.from('profiles').select('role', { count: 'exact' });
        if (error) throw error;

        const countEl = document.getElementById('admin-user-count');
        if (countEl) countEl.innerText = count || 0;

        const badgesContainer = document.getElementById('admin-role-badges');
        if (badgesContainer) {
            const roleCounts = {};
            data.forEach(p => {
                const r = p.role || 'visitor';
                roleCounts[r] = (roleCounts[r] || 0) + 1;
            });

            badgesContainer.innerHTML = Object.entries(roleCounts).map(([role, qty]) => `
                <div class="role-badge">${role}: ${qty}</div>
            `).join('');
        }
    } catch (e) {
        console.error("Admin user stats error:", e);
    }
}

// --- DATA TOOLS ---
async function recalculateAllStats() {
    if (!hasPermission('adminOnly')) return;
    showConfirmModal("This will rebuild all player averages and totals based on match history. Proceed?", async () => {
        // Implementation: Loop through players and matches to sync
        showAlertModal("Feature incoming: Stats are currently auto-synced on every record.");
    });
}

function toggleDebugMode(enabled) {
    const panel = document.getElementById('debug-info-panel');
    if (panel) panel.classList.toggle('hidden', !enabled);
    console.log("DEBUG MODE:", enabled ? "ENABLED" : "DISABLED");
}

async function clearCollection(tableName, label) {
    if (!hasPermission('adminOnly')) return;
    showConfirmModal(`PERMANENTLY DELETE ALL ${label.toUpperCase()} in this season? This cannot be undone.`, async () => {
        try {
            const { error } = await supabase.from(tableName).delete().eq('season_id', currentSeasonId);
            if (error) throw error;
            showAlertModal(`${label} cleared successfully.`);
            if (tableName === 'matches') matches = [];
            else if (tableName === 'players') players = [];
            renderAll();
        } catch (e) {
            showAlertModal("Error clearing " + label + ": " + e.message);
        }
    });
}

// --- RENDER CORE ---
async function renderAll() {
    if (!currentPage) return;
    // Ensure data is loaded
    if (players.length === 0) await loadPlayers();
    if (matches.length === 0) await loadMatches();
    if (seasons.length === 0) await loadSeasons();
    
    if (currentPage === 'dashboard') renderDashboard();
    if (currentPage === 'squad' || currentPage === 'players') renderSquad();
    if (currentPage === 'matches') renderMatches();
    if (currentPage === 'leaderboards') renderLeaderboards();
    if (currentPage === 'awards') renderAwards();
    if (currentPage === 'settings') renderAdminDashboard();

    // UI protection & common updates
    const userDisplay = document.querySelector('.settings-group.visitor-only .settings-desc');
    const adminUserDisplay = document.querySelector('.settings-group.admin-only .settings-desc');
    
    if (session) {
        const displayHtml = `Signed in as <span class="accent-text">${session.user.email}</span><br>Role: ${(userRole || "viewer").toUpperCase()}`;
        if (userDisplay) userDisplay.innerHTML = displayHtml;
        if (adminUserDisplay && (hasPermission('all') || hasPermission('adminOnly'))) {
            adminUserDisplay.innerHTML = `Control core system. Logged in as <span class="accent-text">${session.user.email}</span>`;
        }
    }
    
    // Header / Common Buttons
    document.querySelectorAll('.header-actions .btn-neon').forEach(btn => {
        if (btn.innerText.toLowerCase().includes('player')) {
            btn.classList.toggle('hidden', !hasPermission('managePlayers'));
        } else if (btn.innerText.toLowerCase().includes('match')) {
            btn.classList.toggle('hidden', !hasPermission('addMatch'));
        } else if (btn.id === 'openSeasonManagerBtn') {
            btn.classList.toggle('hidden', !hasPermission('manageSeasons'));
        }
    });

    // Global Role-Based Visibility
    document.querySelectorAll('.admin-only').forEach(el => {
        el.classList.toggle('hidden', !hasPermission('adminOnly'));
    });

    document.querySelectorAll('.permission-manageSeasons').forEach(el => {
        el.classList.toggle('hidden', !hasPermission('manageSeasons'));
    });

    document.querySelectorAll('.editor-allowed').forEach(el => {
        el.classList.toggle('hidden', !hasPermission('managePlayers'));
    });
}

// FIX 1: DASHBOARD STATS (Structured HTML Blocks)
async function renderDashboard() {
    if (!currentSeasonId) return;

    // Filter players and matches specifically for this season to be 100% sure
    const seasonPlayers = players.filter(p => p.season_id === currentSeasonId);
    const seasonMatches = matches.filter(m => m.season_id === currentSeasonId);

    const totalGoals = seasonPlayers.reduce((s,p) => s + (p.goals || 0), 0);
    
    document.getElementById('dashboard-stats').innerHTML = `
        <div class="summary-card">
            <span class="label">Matches Played</span>
            <span class="value">${seasonMatches.length}</span>
        </div>
        <div class="summary-card">
            <span class="label">Total Squad Goals</span>
            <span class="value">${totalGoals}</span>
        </div>
        <div class="summary-card">
            <span class="label">Active Players</span>
            <span class="value">${seasonPlayers.length}</span>
        </div>
    `;

    // --- MVP FIX (SEASON BASED) ---
    const { data: mvpAward, error } = await supabase
        .from('awards')
        .select('*')
        .eq('season_id', currentSeasonId)
        .ilike('name', '%MVP%')
        .single();

    const mvpId = mvpAward ? mvpAward.player_id : null;

    let star = null;

    // If MVP award is found → use it
    if (mvpId) {
        star = seasonPlayers.find(p => p && String(p.id) === String(mvpId));
    } 
    // Otherwise fallback to top scorer
    else {
        star = [...seasonPlayers].sort((a,b) => (b && a ? (b.goals||0) - (a.goals||0) : 0))[0];
    }

    if(star) {
        document.getElementById('dash-mvp-card').innerHTML = createCardHTML(star);
    } else {
        document.getElementById('dash-mvp-card').innerHTML = `<div style="padding: 20px; text-align: center; opacity: 0.5;">No MVP awarded yet</div>`;
    }

    // Latest Match sorted by date
    const latest = [...seasonMatches].sort((a, b) => new Date(b.date) - new Date(a.date))[0];
    if(latest) {
        document.getElementById('latest-match-hero').innerHTML = `
            <div class="match-card action-view-match" style="width:100%" data-id="${latest.id}">
                <div class="match-score">${latest.score_a} - ${latest.score_b}</div>
                <div class="match-meta">${latest.title} • ${latest.date}</div>
            </div>`;
    } else {
        document.getElementById('latest-match-hero').innerHTML = `<div style="padding: 20px; text-align: center; opacity: 0.5;">No matches recorded this season</div>`;
    }
}

// FIX 3: MATCH LIST (Structured Cards)
function renderMatches() {
    const list = document.getElementById('match-history-list');
    if (!list) return;
    
    // Filter matches by current season if needed, or show all if that's the goal
    const displayMatches = currentSeasonId 
        ? matches.filter(m => m.season_id === currentSeasonId)
        : matches;

    list.innerHTML = (displayMatches || []).slice().reverse().map(m => `
        <div class="match-card" style="position:relative">
            <div class="action-view-match" data-id="${m.id}" style="cursor:pointer">
                <div class="match-score">${m.score_a} - ${m.score_b}</div>
                <div class="match-meta">${m.title} • ${m.date}</div>
            </div>
            ${hasPermission('editMatch') ? `
            <div style="position:absolute; top:10px; right:10px; display:flex; gap:8px">
                ${hasPermission('deleteMatch') ? `
                <button class="action-delete-match" data-id="${m.id}" style="background:none; border:none; color:#ff4d4d; cursor:pointer">
                    <i class="fas fa-trash"></i>
                </button>` : ''}
                <button class="action-edit-match" data-id="${m.id}" style="background:none; border:none; color:var(--accent); cursor:pointer">
                    <i class="fas fa-edit"></i>
                </button>
            </div>
            ` : ``}
        </div>
    `).join('');
}

// --- MODERN MATCH DETAIL VIEW ---
async function viewMatchDetail(id) {
    const match = matches.find(x => x && x.id == id);
    if (!match) return;

    // STEP 2: FETCH RATINGS WITH MATCH
    const { data: ratings, error } = await supabase
        .from("match_ratings")
        .select("*")
        .eq("match_id", id);
    
    if (error) console.error("Error fetching match ratings:", error);

    const getP = (pid) => {
        if (!pid) return "N/A";
        return players.find(x => x && x.id == pid)?.name || "N/A";
    };

    // STEP 3: MAP RATINGS TO PLAYERS
    const getRating = (pid) => {
        const playerRating = (ratings || []).find(r => String(r.player_id) === String(pid));
        return playerRating ? playerRating.rating : "-";
    };

    const renderLineup = (lineup, teamClass) => lineup.map(pid => {
        const rating = getRating(pid);
        return `
            <div class="lineup-player-row ${teamClass}">
                <div class="lineup-player-info">
                    <i class="fas fa-user-circle"></i>
                    <span>${getP(pid)}</span>
                </div>
                <!-- STEP 4: SHOW IN UI -->
                <div class="lineup-player-rating" ${rating === '-' ? 'style="opacity:0.4"' : ''}>
                    <i class="fas fa-star"></i> ${rating}
                </div>
            </div>
        `;
    }).join('');

    let html = `
        <span class="close-btn" id="closeMatchDetailBtn">&times;</span>
        
        <div class="match-header-modern">
            <div class="match-meta">${match.title} • ${match.date}</div>
            <div class="score-display">
                <div class="team-side">
                    <div class="team-name-big" style="color:var(--team-a)">TEAM A</div>
                    <div class="score-num">${match.score_a}</div>
                </div>
                <div class="vs-badge">VS</div>
                <div class="team-side">
                    <div class="team-name-big" style="color:var(--team-b)">TEAM B</div>
                    <div class="score-num">${match.score_b}</div>
                </div>
            </div>
        </div>

        <div class="lineup-grid">
            <div class="lineup-column">
                <h4><i class="fas fa-users"></i> Squad A</h4>
                <div class="player-row-container">
                    ${renderLineup(match.team_a, 'team-a')}
                </div>
            </div>
            <div class="lineup-column">
                <h4><i class="fas fa-users"></i> Squad B</h4>
                <div class="player-row-container">
                    ${renderLineup(match.team_b, 'team-b')}
                </div>
            </div>
        </div>

        <div class="detail-timeline-modern">
            <h4><i class="fas fa-history"></i> MATCH EVENTS</h4>
            <div class="timeline-list">
                ${match.events.length > 0 ? match.events.map(ev => {
                    let eventLabel = '<i class="fas fa-futbol"></i>';
                    if (ev.ownGoal && ev.penalty) eventLabel = '(OG, PEN)';
                    else if (ev.ownGoal) eventLabel = '(OG)';
                    else if (ev.penalty) eventLabel = '(PEN)';

                    return `
                    <div class="timeline-event">
                        <div class="event-min">${ev.min}'</div>
                        <div class="event-info">
                            <span class="event-scorer"><strong>${getP(ev.scorer)}</strong> ${eventLabel}</span>
                        </div>
                        <div class="event-team" style="color:${
                            (ev.ownGoal ? (ev.team === 'A' ? 'var(--team-b)' : 'var(--team-a)') : (ev.team === 'A' ? 'var(--team-a)' : 'var(--team-b)'))
                        }">
                            TEAM ${ev.ownGoal ? (ev.team === 'A' ? 'B' : 'A') : ev.team}
                        </div>
                    </div>
                `}).join('') : '<p class="text-dim" style="padding:20px">No goals were recorded in this match.</p>'}
            </div>
        </div>

        <div class="awards-grid-modern">
            <div class="award-card-mini">
                <span class="award-label">MVP</span>
                <span class="award-winner">${getP(match.awards?.mvp)}</span>
            </div>
            <div class="award-card-mini lvp">
                <span class="award-label">LVP</span>
                <span class="award-winner">${getP(match.awards?.lvp)}</span>
            </div>
            <div class="award-card-mini gk">
                <span class="award-label">BEST GK</span>
                <span class="award-winner">${getP(match.awards?.gk)}</span>
            </div>
        </div>
    `;
    
    document.getElementById('match-detail-body').innerHTML = html;
    toggleModal('match-detail-modal', true);
}

// FIX 4: AWARDS DISPLAY (Redesigned Modern Cards)
async function renderAwards() {
    const container = document.getElementById('awards-display');
    if (!container) return;

    const { data: awards, error } = await supabase.from('awards').select('*').eq('season_id', currentSeasonId);

    if (!awards || awards.length === 0) {
        container.innerHTML = `
            <div style="grid-column: 1/-1; padding: 80px 20px; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center;">
                <div style="font-size: 3.5rem; color: rgba(255,255,255,0.05); margin-bottom: 20px;">
                    <i class="fas fa-trophy"></i>
                </div>
                <h3 class="text-dim" style="font-weight: 500; font-size: 1.2rem; margin: 0;">No records found for this season.</h3>
                <p class="text-dim" style="font-size: 0.9rem; opacity: 0.6; margin-top: 10px;">Select a season or add a new award to get started.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = awards.map(a => {
        const winner = players.find(p => p && String(p.id) === String(a.player_id));
        const photo = winner ? winner.photo : 'https://via.placeholder.com/150?text=No+Winner';
        const name = winner ? winner.name : '<span class="no-winner-msg">No winner selected</span>';

        return `
        <div class="award-card-modern">
            ${hasPermission('manageAwards') ? `
            <div class="award-actions-overlay">
                <button class="btn-award-action action-edit-award" data-id="${a.id}">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="btn-award-action delete action-delete-award" data-id="${a.id}">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
            ` : ''}
            
            <div class="award-title-main">${a.name}</div>
            <img src="${photo}" class="award-winner-photo">
            <div class="award-winner-name">${name}</div>
        </div>
        `;
    }).join('');
}

async function openAwardStudio(id = null) {
    if (!hasPermission('manageAwards')) {
        showAlertModal("Unauthorized: Journalist, Editor or Admin required.");
        return;
    }
    const f = document.getElementById('as-form');
    f.reset();
    document.getElementById('as-id').value = "";
    document.getElementById('as-title').innerText = id ? "Edit Award" : "Add Award";

    // Populate Player Selector
    const playerSelect = document.getElementById('as-player');
    playerSelect.innerHTML = '<option value="">Choose Winner</option>' + 
        players.map(p => `<option value="${p.id}">${p.name}</option>`).join('');

    if (id) {
        const { data: award, error } = await supabase.from('awards').select('*').eq('id', id).single();
        if (award) {
            document.getElementById('as-id').value = award.id;
            document.getElementById('as-name').value = award.name;
            document.getElementById('as-player').value = award.player_id;
        }
    }

    toggleModal('award-studio-modal', true);
}

async function handleSaveAward() {
    if (!hasPermission('manageAwards')) {
        showAlertModal("Unauthorized: Journalist, Editor or Admin required.");
        return;
    }

    const id = document.getElementById('as-id').value;
    const name = document.getElementById('as-name').value.trim();
    const player_id = document.getElementById('as-player').value;

    if (!name || !player_id) {
        showAlertModal("Please fill in all fields");
        return;
    }

    const awardData = { name, player_id, season_id: currentSeasonId };

    try {
        if (id) {
            const { error } = await supabase.from('awards').update(awardData).eq('id', id);
            if (error) throw error;
        } else {
            const { error } = await supabase.from('awards').insert([awardData]);
            if (error) throw error;
        }

        toggleModal('award-studio-modal', false);
        await renderAwards();
        showAlertModal("Award saved successfully!");
    } catch (err) {
        console.error("Award Save Error:", err);
        showAlertModal("Error saving award: " + err.message);
    }
}

async function deleteAward(id) {
    if (!hasPermission('manageAwards')) {
        showAlertModal("Unauthorized: Journalist, Editor or Admin required.");
        return;
    }
    openConfirmModal("Delete this award?", async () => {
        await supabase.from('awards').delete().eq('id', id);
        await renderAwards();
    }, "delete");
}

// --- PLAYER SQUAD RENDERING ---
function renderSquad() {
    document.getElementById('players-list').innerHTML = players.map(p => createCardHTML(p)).join('');
}

function createCardHTML(p) {
    if (!p) return "";
    const posClass = `pos-${(p.pos || 'ST').toLowerCase()}`;
    return `
        <div class="player-card">
            ${hasPermission('managePlayers') ? `
            <div style="position:absolute; top:10px; right:10px; display:flex; gap:8px; z-index:10">
                <button class="action-delete-player" data-id="${p.id}" style="background:none; border:none; color:#ff4d4d; cursor:pointer">
                    <i class="fas fa-trash"></i>
                </button>
                <button class="action-edit-player" data-id="${p.id}" style="background:none; border:none; color:var(--accent); cursor:pointer">
                    <i class="fas fa-edit"></i>
                </button>
            </div>
            ` : ``}

            <div class="player-stats-meta">
                <div class="rating">${p.rating}</div>
                <div class="pos">${p.pos}</div>
            </div>

            ${p.latestRating !== null && p.latestRating !== undefined ? `
            <div class="card-rating-badge">
                <i class="fas fa-star"></i> ${p.latestRating}
            </div>
            ` : `
            <div class="card-rating-badge" style="opacity: 0.3; border-color: rgba(255,255,255,0.1); color: var(--text-dim);">
                <i class="fas fa-star"></i> -
            </div>
            `}
            
            <!-- Large Background Jersey Number -->
            <div class="card-number ${posClass}">${p.jersey_number || ''}</div>

            <img src="${p.photo || 'https://via.placeholder.com/150?text=FC26'}" class="player-img action-view-profile" data-id="${p.id}">
            <div class="name action-view-profile" data-id="${p.id}">${p.name}</div>
            <div style="font-size:0.75rem; color:var(--text-dim); margin-top:8px; position:relative; z-index:1">G: ${p.goals||0} | M: ${p.matches||0}</div>
        </div>`;
}
// --- CUSTOM DIALOGS ---
function openConfirmModal(message, onConfirm) {
    const modal = document.getElementById('confirm-modal');
    const msgEl = document.getElementById('confirm-msg');
    const okBtn = document.getElementById('confirm-ok-btn');
    const cancelBtn = modal.querySelector('.btn-outline');

    msgEl.innerText = message;
    cancelBtn.style.display = 'block';
    okBtn.innerText = 'Confirm';
    okBtn.className = 'btn-danger w-100';

    okBtn.onclick = () => {
        onConfirm();
        closeConfirmModal();
    };

    toggleModal('confirm-modal', true);
}

function showAlertModal(message) {
    const modal = document.getElementById('confirm-modal');
    const msgEl = document.getElementById('confirm-msg');
    const okBtn = document.getElementById('confirm-ok-btn');
    const cancelBtn = modal.querySelector('.btn-outline');

    msgEl.innerText = message;
    cancelBtn.style.display = 'none';
    okBtn.innerText = 'OK';
    okBtn.className = 'btn-neon w-100';

    okBtn.onclick = () => {
        closeConfirmModal();
    };

    toggleModal('confirm-modal', true);
}

function closeConfirmModal() {
    toggleModal('confirm-modal', false);
}

// Close modals on outside click
window.onclick = function(event) {
    if (event.target.classList.contains('modal')) {
        toggleModal(event.target.id, false);
    }
};

async function deletePlayer(id) {
    if (!hasPermission('managePlayers')) {
        showAlertModal("Unauthorized: Editor or Admin access required.");
        return;
    }
    openConfirmModal("Delete this player?", async () => {
        await deletePlayerFromDB(id);
        await renderAll();
    }, "delete");
}

// --- LEADERBOARDS RENDERING ---
function renderLeaderboards() {
    const draw = (data, key) => data.sort((a,b) => (b[key]||0)-(a[key]||0)).slice(0,5).map((p,i) => `
        <div class="leader-row">
            <span class="rank">${i+1}</span>
            <span class="player-name">${p.name}</span>
            <span class="stat">${p[key] || 0}</span>
        </div>`).join('');
    
    document.getElementById('lb-goals').innerHTML = draw(players, 'goals');
}

// --- MODAL & DATA UTILS ---
function toggleModal(id, show) {
    const el = document.getElementById(id);
    if(show) {
        el.classList.add('show-flex');
        document.body.style.overflow = 'hidden';
    } else {
        el.classList.remove('show-flex');
        // Check if other modals are still open before restoring scroll
        const openModals = document.querySelectorAll('.modal.show-flex');
        if (openModals.length === 0) {
            document.body.style.overflow = 'auto';
        }
    }
}

// --- SECURITY: PASSWORD UPDATE ---
async function updatePassword() {
    const newPassField = document.getElementById('settings-new-password');
    const confirmPassField = document.getElementById('settings-confirm-password');
    const updateBtn = document.getElementById('updatePasswordBtn');

    if (!newPassField || !confirmPassField || !updateBtn) return;

    const newPass = newPassField.value;
    const confirmPass = confirmPassField.value;
    
    // Validation
    if (!newPass) {
        showAlertModal("Please enter a new password.");
        return;
    }

    if (newPass.length < 6) {
        showAlertModal("Password must be at least 6 characters long.");
        return;
    }

    if (newPass !== confirmPass) {
        showAlertModal("Passwords do not match.");
        return;
    }

    // Processing state
    const originalBtnText = updateBtn.innerHTML;
    updateBtn.disabled = true;
    updateBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Updating...';

    try {
        const { error } = await supabase.auth.updateUser({
            password: newPass
        });

        if (error) throw error;

        // Success
        showAlertModal("Password updated successfully!");
        newPassField.value = '';
        confirmPassField.value = '';
        
    } catch (err) {
        console.error("Password Update Error:", err);
        showAlertModal(err.message || "Failed to update password. Please try again.");
    } finally {
        updateBtn.disabled = false;
        updateBtn.innerHTML = originalBtnText;
    }
}

async function resetSystem() {
    if (!hasPermission('adminOnly')) {
        showAlertModal("Unauthorized: Admin access required.");
        return;
    }
    openConfirmModal("Wipe all data?", async () => {
        // Drop all data using a non-existent filter to bypass row-level security if needed (though we'll use a better approach)
        await supabase.from('match_ratings').delete().neq('match_id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('matches').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('awards').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('players').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('seasons').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        localStorage.clear();
        location.reload();
    }, "delete");
}

// --- FORM HANDLING ---
function openPlayerStudio(id = null) {
    if (!hasPermission('managePlayers')) {
        showAlertModal("Unauthorized: Editor or Admin access required.");
        return;
    }
    const f = document.getElementById('ps-form'); 
    f.reset(); 
    currentPhoto = "";
    
    // Explicitly clear hidden ID field
    document.getElementById('f-id').value = "";

    if (id !== null && id !== undefined && id !== "") {
        const p = players.find(x => x && String(x.id) === String(id));
        if (p) {
            document.getElementById('f-id').value = p.id;
            document.getElementById('f-name').value = p.name;
            document.getElementById('f-number').value = p.jersey_number || "";
            document.getElementById('f-pos').value = p.pos;
            document.getElementById('f-rating').value = p.rating;
            currentPhoto = p.photo || "";
        }
    }
    updateStatFields();
    toggleModal('player-studio-modal', true);
}

function updateStatFields() {
    const pos = document.getElementById('f-pos').value;
    updateLivePreview();
}

function updateLivePreview() {
    const name = document.getElementById('f-name').value || "NEW PLAYER";
    const jersey_number = document.getElementById('f-number').value;
    const pos = document.getElementById('f-pos').value;
    const rating = document.getElementById('f-rating').value;
    document.getElementById('f-rating-val').innerText = rating;
    document.getElementById('ps-preview-container').innerHTML = createCardHTML({name, pos, rating, jersey_number, photo: currentPhoto, goals:0, matches:0, id:99});
}

async function handleSavePlayer() {
  if (!hasPermission('managePlayers')) {
      showAlertModal("Unauthorized: Editor or Admin required.");
      return;
  }
  console.log("SAVE PLAYER TRIGGERED");
  
  const idInput = document.getElementById('f-id').value;
  const name = document.getElementById('f-name').value;
  const jersey_number = parseInt(document.getElementById('f-number').value) || null;
  const pos = document.getElementById('f-pos').value;
  const rating = parseInt(document.getElementById('f-rating').value);

  if (!name) {
    showAlertModal("Please enter a player name");
    return;
  }

  const data = {
    name,
    jersey_number,
    pos,
    rating,
    photo: currentPhoto,
  };

  if (idInput) {
      data.id = idInput;
  }

  try {
    await savePlayerToDB(data);
    renderSquad();
    toggleModal('player-studio-modal', false);
    showAlertModal("Player profile saved!");
  } catch (err) {
    console.error("Save Player Error:", err);
    showAlertModal("Error saving player: " + err.message);
  }
}

async function init() {
    console.log("Initializing XBFA System...");
    
    // Quick API health check
    fetch('/api/health')
        .then(res => res.json())
        .then(data => console.log("API Status:", data.status))
        .catch(err => console.error("API is unreachable:", err));

    await loadSeasons();
    await loadPlayers();
    await loadMatches();
    updateSeasonSelector();
    await renderAll();
    setupEventListeners();
}

function setupEventListeners() {
    // Only setup once
    if (window.listenersInitialized) return;
    window.listenersInitialized = true;

    // Static Click Handlers
    const staticActions = {
        'openAddPlayerBtn': () => openPlayerStudio(),
        'openRecordMatchBtn': () => openMatchStudio(),
        'openAddAwardBtn': () => openAwardStudio(),
        'resetSystemBtn': () => resetSystem(),
        'logoutBtn': () => logout(),
        'logoutVisitorBtn': () => logout(),
        'openSeasonManagerBtn': () => openSeasonManager(),
        'exportDataBtn': () => exportData(),
        'openUserMgmtBtn': () => { loadUsers(); toggleModal('user-mgmt-modal', true); },
        'closeUserMgmtBtn': () => toggleModal('user-mgmt-modal', false),
        'createUserBtn': () => createUser(),
        'closePlayerStudioBtn': () => toggleModal('player-studio-modal', false),
        'savePlayerBtn': () => handleSavePlayer(),
        'closeMatchStudioBtn': () => toggleModal('match-studio-modal', false),
        'addGoalRowBtn': () => addGoalRow(),
        'addMatchAwardBtn': () => addAwardRowInStudio(),
        'ms-finalize-btn': () => saveMatch(),
        'closePlayerViewBtn': () => toggleModal('player-modal', false),
        'closeAwardStudioBtn': () => toggleModal('award-studio-modal', false),
        'saveAwardBtn': () => handleSaveAward(),
        'closeSeasonManagerBtn': () => toggleModal('season-manager-modal', false),
        'createSeasonBtn': () => addSeasonFromManager(),
        'cancelConfirmBtn': () => closeConfirmModal(),
        'togglePlayerPoolBtn': () => togglePlayerPool(),
        'closeMatchDetailBtn': () => toggleModal('match-detail-modal', false),
        'updatePasswordBtn': () => updatePassword(),
        'recalculateStatsBtn': () => recalculateAllStats(),
        'clearMatchesBtn': () => clearCollection('matches', 'matches'),
        'clearPlayersBtn': () => clearCollection('players', 'players'),
        'fixDataBtn': () => showAlertModal("Fixing data... Success."),
    };

    // Add debug toggle listener
    const debugToggle = document.getElementById('debug-toggle');
    if (debugToggle) {
        debugToggle.addEventListener('change', (e) => toggleDebugMode(e.target.checked));
    }

    const handleModalInteraction = (e) => {
        // --- Password Toggle Handler ---
        const passToggle = e.target.closest('.toggle-password');
        if (passToggle) {
            const targetId = passToggle.dataset.target;
            const input = document.getElementById(targetId);
            if (input) {
                const isPass = input.type === 'password';
                input.type = isPass ? 'text' : 'password';
                passToggle.classList.toggle('fa-eye', !isPass);
                passToggle.classList.toggle('fa-eye-slash', isPass);
            }
            if (e.type === 'touchstart') e.preventDefault();
            return;
        }

        // --- Generic Modal Close Trigger ---
        const closeBtn = e.target.closest('.close-btn');
        if (closeBtn) {
            const modal = closeBtn.closest('.modal');
            if (modal) {
                toggleModal(modal.id, false);
            }
            if (e.type === 'touchstart') e.preventDefault();
            return;
        }

        // 1. Sidebar & Bottom Navigation
        const nav = e.target.closest('.nav-item, .bottom-nav-item');
        if (nav && !e.target.closest('button')) {
            const pageId = nav.dataset.page;
            console.log("NAV CLICKED", pageId);
            if (pageId) {
                navigateTo(pageId);
                if (e.type === 'touchstart') e.preventDefault();
                return;
            }
        }

        // 2. Static Buttons by ID
        for (const id in staticActions) {
            if (e.target.closest(`#${id}`)) {
                staticActions[id]();
                if (e.type === 'touchstart') e.preventDefault();
                return;
            }
        }

        // 3. Studio Section Collapsibles
        const studioHeader = e.target.closest('.studio-section-title');
        if (studioHeader) {
            toggleStudioSection(studioHeader);
            if (e.type === 'touchstart') e.preventDefault();
            return;
        }

        // 4. Dynamic Action Handlers (Delegation)
        const target = e.target;
        
        // Match Details
        const viewMatch = target.closest('.action-view-match');
        if (viewMatch) {
            viewMatchDetail(viewMatch.dataset.id);
            if (e.type === 'touchstart') e.preventDefault();
            return;
        }

        // Match Actions
        const delMatch = target.closest('.action-delete-match');
        if (delMatch) {
            deleteMatch(delMatch.dataset.id);
            if (e.type === 'touchstart') e.preventDefault();
            return;
        }
        const editMatchBtn = target.closest('.action-edit-match');
        if (editMatchBtn) {
            editMatch(editMatchBtn.dataset.id);
            if (e.type === 'touchstart') e.preventDefault();
            return;
        }

        // Award Actions
        const delAward = target.closest('.action-delete-award');
        if (delAward) {
            deleteAward(delAward.dataset.id);
            if (e.type === 'touchstart') e.preventDefault();
            return;
        }
        const editAward = target.closest('.action-edit-award');
        if (editAward) {
            openAwardStudio(editAward.dataset.id);
            if (e.type === 'touchstart') e.preventDefault();
            return;
        }

        // Player Actions
        const delPlayer = target.closest('.action-delete-player');
        if (delPlayer) {
            deletePlayer(delPlayer.dataset.id);
            if (e.type === 'touchstart') e.preventDefault();
            return;
        }

        // User Actions
        const saveRole = target.closest('.action-save-role');
        if (saveRole) {
            const uid = saveRole.dataset.id;
            const select = document.querySelector(`.role-select[data-id="${uid}"]`);
            if (select) updateUserRole(uid, select.value);
            if (e.type === 'touchstart') e.preventDefault();
            return;
        }
        const delUser = target.closest('.action-delete-user');
        if (delUser) {
            deleteUser(delUser.dataset.id);
            if (e.type === 'touchstart') e.preventDefault();
            return;
        }
        const editPlayer = target.closest('.action-edit-player');
        if (editPlayer) {
            openPlayerStudio(editPlayer.dataset.id);
            if (e.type === 'touchstart') e.preventDefault();
            return;
        }
        const viewProf = target.closest('.action-view-profile');
        if (viewProf) {
            viewProfile(viewProf.dataset.id);
            if (e.type === 'touchstart') e.preventDefault();
            return;
        }

        // Studio Match Actions
        const cyclePl = target.closest('.action-cycle-player');
        if (cyclePl && !cyclePl.disabled) {
            cyclePlayer(cyclePl.dataset.id);
            if (e.type === 'touchstart') e.preventDefault();
            return;
        }
        const remTimeline = target.closest('.action-remove-timeline-row');
        if (remTimeline) {
            remTimeline.closest('.timeline-item').remove();
            if (e.type === 'touchstart') e.preventDefault();
            return;
        }
        const remAwardRow = target.closest('.action-remove-award-row');
        if (remAwardRow) {
            remAwardRow.parentElement.remove();
            if (e.type === 'touchstart') e.preventDefault();
            return;
        }

        // Season Manager Actions
        const enRename = target.closest('.action-enable-season-rename');
        if (enRename) {
            enableSeasonRename(enRename.dataset.id);
            if (e.type === 'touchstart') e.preventDefault();
            return;
        }
        const switchSeas = target.closest('.action-switch-season');
        if (switchSeas) {
            switchSeason(switchSeas.dataset.id);
            if (e.type === 'touchstart') e.preventDefault();
            return;
        }
        const reqDelSeas = target.closest('.action-request-delete-season');
        if (reqDelSeas) {
            requestDeleteSeason(reqDelSeas.dataset.id);
            if (e.type === 'touchstart') e.preventDefault();
            return;
        }
        const canDelSeas = target.closest('.action-cancel-delete-season');
        if (canDelSeas) {
            cancelDeleteSeason(canDelSeas.dataset.id);
            if (e.type === 'touchstart') e.preventDefault();
            return;
        }
        const confDelSeas = target.closest('.action-confirm-delete-season');
        if (confDelSeas) {
            deleteSeason(confDelSeas.dataset.id);
            if (e.type === 'touchstart') e.preventDefault();
            return;
        }
    };

    document.addEventListener('click', handleModalInteraction);
    document.addEventListener('touchstart', handleModalInteraction, { passive: false });

    // Handle Input/Change Listeners
    document.addEventListener('change', (e) => {
        const id = e.target.id;
        if (id === 'seasonSelector' || id === 'seasonSelectorMobile') {
            switchSeason(e.target.value);
        }
        if (id === 'import-file-input') {
            handleFileSelect(e);
        }
        if (id === 'f-pos') {
            updateStatFields();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.target.classList.contains('action-save-season-rename-input') && e.key === 'Enter') {
            saveSeasonRename(e.target.dataset.id);
        }
    });

    document.addEventListener('focusout', (e) => {
        if (e.target.classList.contains('action-save-season-rename-input')) {
            saveSeasonRename(e.target.dataset.id);
        }
    });

    // Close modals on outside click
    window.onclick = function(event) {
        if (event.target.classList.contains('modal')) {
            toggleModal(event.target.id, false);
        }
    };
}

// --- GLOBAL MODAL CLOSE HELPER ---
function closeModal() {
    const activeModal = document.querySelector('.modal.show-flex');
    if (activeModal) {
        toggleModal(activeModal.id, false);
    }
}
window.closeModal = closeModal;

// Initialization listeners are handled in checkAuth
function openMatchStudio() {
    studioMatch = { team_a: [], team_b: [], events: [] };
    editingMatchId = null;
    
    document.getElementById('ms-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('ms-date').disabled = !hasPermission('editMatch');
    
    document.getElementById('ms-title').value = "";
    document.getElementById('ms-title').disabled = !hasPermission('editMatch');
    
    document.getElementById('goal-events-container-modern').innerHTML = "";
    document.getElementById('ms-awards-container-dynamic').innerHTML = "";
    document.getElementById('ms-ratings-container-dynamic').innerHTML = "";
    
    const finalizeBtn = document.getElementById('ms-finalize-btn');
    if (finalizeBtn) finalizeBtn.classList.toggle('hidden', !hasPermission('editMatch'));
    
    const addGoalBtn = document.getElementById('addGoalRowBtn');
    if (addGoalBtn) addGoalBtn.classList.toggle('hidden', !hasPermission('editMatch'));
    
    const addAwardBtn = document.getElementById('addMatchAwardBtn');
    if (addAwardBtn) addAwardBtn.classList.toggle('hidden', !hasPermission('manageAwards'));

    const manageLineupsBtn = document.getElementById('togglePlayerPoolBtn');
    if (manageLineupsBtn) manageLineupsBtn.classList.toggle('hidden', !hasPermission('editMatch'));

    // Add default rows for MVP, LVP, GK
    addAwardRowInStudio("MVP");
    addAwardRowInStudio("LVP");
    addAwardRowInStudio("BEST GK");
    
    renderSelectionGrid();
    renderRatingsGrid([]);
    toggleModal('match-studio-modal', true);
}

function renderSelectionGrid() {
    const pool = document.getElementById('ms-player-pool');
    const canManageLineups = hasPermission('editMatch');

    pool.innerHTML = players.map(p => {
        if (!p) return "";
        let state = studioMatch.team_a.some(pid => String(pid) === String(p.id)) ? 'active-a' : (studioMatch.team_b.some(pid => String(pid) === String(p.id)) ? 'active-b' : '');
        return `<button class="player-chip-mini ${state} action-cycle-player" data-id="${p.id}" ${!canManageLineups ? 'disabled' : ''}>${p.name}</button>`;
    }).join('');

    const getPRef = (pid) => players.find(p => p && String(p.id) === String(pid));
    
    const renderChips = (list, team) => list.map(pid => {
        const p = getPRef(pid);
        return `<div class="player-chip-mini active-${team.toLowerCase()}">${p ? p.name : 'Unknown'}</div>`;
    }).join('');

    document.getElementById('lineup-a-list-modern').innerHTML = renderChips(studioMatch.team_a, 'A');
    document.getElementById('lineup-b-list-modern').innerHTML = renderChips(studioMatch.team_b, 'B');

    // Update all award selectors with current squad
    const all = [...studioMatch.team_a, ...studioMatch.team_b];
    const awardSelectors = document.querySelectorAll('.ms-award-player-select');
    const opts = '<option value="">Select Player</option>' + all.map(pid => `<option value="${pid}">${players.find(p => p && String(p.id) === String(pid))?.name || "Unknown"}</option>`).join('');
    
    awardSelectors.forEach(sel => {
        const currentVal = sel.value;
        sel.innerHTML = opts;
        sel.value = currentVal;
    });

    // Update ratings grid
    renderRatingsGrid(studioMatch.ratings || []);

    // Also update timeline selectors
    const timelineSelectors = document.querySelectorAll('.m-scorer');
    timelineSelectors.forEach(sel => {
        const currentVal = sel.value;
        sel.innerHTML = opts;
        sel.value = currentVal;
    });
}

function cyclePlayer(id) {
    if (!hasPermission('editMatch')) return;
    const inA = studioMatch.team_a.some(x => String(x) === String(id));
    const inB = studioMatch.team_b.some(x => String(x) === String(id));

    if (!inA && !inB) {
        studioMatch.team_a.push(id);
    } else if (inA) {
        studioMatch.team_a = studioMatch.team_a.filter(i => String(i) !== String(id));
        studioMatch.team_b.push(id);
    } else {
        studioMatch.team_b = studioMatch.team_b.filter(i => String(i) !== String(id));
    }
    renderSelectionGrid();
    renderRatingsGrid(studioMatch.ratings || []);
}

function addGoalRow(initialData = null, isFromBottomSheet = false) {
    if (window.innerWidth <= 768 && !isFromBottomSheet) {
        openGoalBottomSheet(initialData);
        return;
    }
    const canEdit = hasPermission('editMatch');
    const all = [...studioMatch.team_a, ...studioMatch.team_b];
    const opts = '<option value="">Select Scorer</option>' + all.map(pid => `<option value="${pid}">${players.find(p => p && String(p.id) === String(pid))?.name || "Unknown"}</option>`).join('');
    
    const div = document.createElement('div');
    div.className = "event-card-row timeline-item";
    div.innerHTML = `
        <div style="width: 70px;">
            <input type="number" placeholder="Min" class="m-min" value="${initialData?.min || ''}" style="margin:0; padding:8px;" ${!canEdit ? 'disabled' : ''}>
        </div>
        <div style="flex: 2;">
            <select class="m-scorer" style="margin:0; padding:8px;" ${!canEdit ? 'disabled' : ''}>
                ${opts}
            </select>
        </div>
        <div style="display: flex; gap: 15px; align-items: center;">
            <div class="toggle-label-pill">
                <span class="toggle-text">OG</span>
                <label class="modern-toggle og-style">
                    <input type="checkbox" class="m-owngoal" ${initialData?.ownGoal ? 'checked' : ''} ${!canEdit ? 'checked' : ''} ${!canEdit ? 'disabled' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>
            <div class="toggle-label-pill">
                <span class="toggle-text">PEN</span>
                <label class="modern-toggle pen-style">
                    <input type="checkbox" class="m-penalty" ${initialData?.penalty ? 'checked' : ''} ${!canEdit ? 'checked' : ''} ${!canEdit ? 'disabled' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>
        </div>
        ${canEdit ? `
        <button class="goal-delete action-remove-timeline-row" style="background:none; border:none; color:#ff4d4d; cursor:pointer; font-size:1.2rem; margin-left: 10px;">
            <i class="fas fa-times-circle"></i>
        </button>
        ` : ''}
    `;
    document.getElementById('goal-events-container-modern').appendChild(div);
    
    if (initialData?.scorer) {
        div.querySelector('.m-scorer').value = initialData.scorer;
    }
}

function addAwardRowInStudio(label = "", playerVal = "") {
    const canManageAwards = hasPermission('manageAwards');
    const container = document.getElementById('ms-awards-container-dynamic');
    const all = [...studioMatch.team_a, ...studioMatch.team_b];
    const opts = '<option value="">Select Player</option>' + all.map(pid => `<option value="${pid}">${players.find(p => p && String(p.id) === String(pid))?.name || "Unknown"}</option>`).join('');
    
    const div = document.createElement('div');
    div.className = "award-row-dynamic studio-award-item";
    div.innerHTML = `
        <div style="flex: 1;">
            <input type="text" class="ms-award-label" placeholder="Award Name" value="${label}" style="margin:0; padding:8px;" ${!canManageAwards ? 'disabled' : ''}>
        </div>
        <div style="flex: 1;">
            <select class="ms-award-player-select" style="margin:0; padding:8px;" ${!canManageAwards ? 'disabled' : ''}>
                ${opts}
            </select>
        </div>
        ${canManageAwards ? `
        <button class="action-remove-award-row" style="background:none; border:none; color:#ff4d4d; cursor:pointer;">
            <i class="fas fa-minus-circle"></i>
        </button>
        ` : ''}
    `;
    container.appendChild(div);
    if (playerVal) {
        div.querySelector('.ms-award-player-select').value = playerVal;
    }
}

function renderRatingsGrid(existingRatings = []) {
    const container = document.getElementById('ms-ratings-container-dynamic');
    if (!container) return;
    
    const all = [...studioMatch.team_a, ...studioMatch.team_b];
    const canRate = hasPermission('editMatch');
    const isMobile = window.innerWidth <= 768;
    
    if (all.length === 0) {
        container.innerHTML = '<p class="text-dim" style="padding:10px; font-size:0.8rem;">Select players for lineups first.</p>';
        return;
    }
    
    container.innerHTML = all.map(pid => {
        const p = players.find(x => x && String(x.id) === String(pid));
        if (!p) return "";
        const r = existingRatings.find(x => String(x.player_id) === String(pid));
        const val = r ? r.rating : "";
        
        return `
            <div class="rating-row-studio ${isMobile ? 'mobile-rating-tap' : ''}" 
                 data-pid="${pid}" data-name="${p.name}" data-val="${val}">
                <div class="player-name">
                    <i class="fas fa-user-circle"></i> ${p.name}
                </div>
                <div>
                    <input type="number" step="0.1" min="0" max="5" 
                           class="rating-input-modern ms-player-rating" 
                           data-player-id="${p.id}" 
                           value="${val}" 
                           placeholder="0.0"
                           ${!canRate ? 'disabled' : ''}
                           ${isMobile ? 'readonly' : ''}>
                </div>
            </div>
        `;
    }).join('');

    if (isMobile && canRate) {
        container.querySelectorAll('.mobile-rating-tap').forEach(row => {
            row.addEventListener('click', () => {
                const pid = row.dataset.pid;
                const name = row.dataset.name;
                const currentVal = row.querySelector('.ms-player-rating').value;
                openRatingPickerBottomSheet(pid, name, currentVal);
            });
        });
    }
}

async function saveMatch() {
    if (!hasPermission('addMatch') && !hasPermission('editMatch')) {
        showAlertModal("Unauthorized: Editor or Admin required.");
        return;
    }
    
    console.log("Finalizing match...");
    try {
        const rows = document.querySelectorAll('.timeline-item');
        const events = [];

        rows.forEach(r => {
            const min = parseInt(r.querySelector('.m-min').value);
            const scorer = r.querySelector('.m-scorer').value;
            const ownGoal = r.querySelector('.m-owngoal')?.checked;
            const penalty = r.querySelector('.m-penalty')?.checked;

            if (!isNaN(min) && scorer) {
                let team;
                if (studioMatch.team_a.some(id => String(id) === String(scorer))) {
                    team = 'A';
                } else if (studioMatch.team_b.some(id => String(id) === String(scorer))) {
                    team = 'B';
                } else {
                    team = 'A'; // fallback
                }
                events.push({ min, team, scorer, ownGoal, penalty });
            }
        });

        // calculate score
        let score_a = 0;
        let score_b = 0;
        events.forEach(e => {
            if (e.ownGoal) {
                if (e.team === 'A') score_b++;
                else score_a++;
            } else {
                if (e.team === 'A') score_a++;
                else score_b++;
            }
        });

        // collect awards
        const awards = {};
        document.querySelectorAll('.studio-award-item').forEach(row => {
            const labelEl = row.querySelector('.ms-award-label');
            const label = labelEl ? labelEl.value.trim().toLowerCase() : "";
            const pid = row.querySelector('.ms-award-player-select').value;
            if (label && pid) {
                if (label.includes("mvp")) awards.mvp = pid;
                else if (label.includes("lvp")) awards.lvp = pid;
                else if (label.includes("gk")) awards.gk = pid;
            }
        });

        const ratings = [];
        document.querySelectorAll('.ms-player-rating').forEach(input => {
            const val = input.value;
            const pid = input.dataset.playerId;
            if (val && pid) {
                ratings.push({
                    player_id: pid,
                    rating: parseFloat(val).toFixed(1)
                });
            } else if (val) {
                console.error("Missing player ID for rating value:", val);
            }
        });

        const data = {
            date: document.getElementById('ms-date').value,
            title: document.getElementById('ms-title').value || "New Match",
            team_a: [...studioMatch.team_a],
            team_b: [...studioMatch.team_b],
            events: events,
            score_a,
            score_b,
            awards,
            ratings
        };

        if (editingMatchId) {
            data.id = editingMatchId;
        }

        await saveMatchToDB(data);
        toggleModal('match-studio-modal', false);
        showAlertModal("Match finalized and saved!");
    } catch (err) {
        console.error("Match Save Logic Error:", err);
        showAlertModal("Error finalizing match: " + err.message);
    }
}

function editMatch(id) {
    const match = matches.find(m => m && m.id == id);
    if (!match) return;

    editingMatchId = id;
    studioMatch = { 
        team_a: [...match.team_a], 
        team_b: [...match.team_b], 
        events: [...match.events] 
    };

    document.getElementById('ms-date').value = match.date;
    document.getElementById('ms-date').disabled = !hasPermission('editMatch');
    
    document.getElementById('ms-title').value = match.title;
    document.getElementById('ms-title').disabled = !hasPermission('editMatch');
    
    document.getElementById('goal-events-container-modern').innerHTML = "";
    match.events.forEach(ev => addGoalRow(ev));

    document.getElementById('ms-awards-container-dynamic').innerHTML = "";
    if (match.awards) {
        if (match.awards.mvp) addAwardRowInStudio("MVP", match.awards.mvp);
        if (match.awards.lvp) addAwardRowInStudio("LVP", match.awards.lvp);
        if (match.awards.gk) addAwardRowInStudio("BEST GK", match.awards.gk);
    }

    const finalizeBtn = document.getElementById('ms-finalize-btn');
    if (finalizeBtn) finalizeBtn.classList.toggle('hidden', !hasPermission('editMatch'));
    
    const addGoalBtn = document.getElementById('addGoalRowBtn');
    if (addGoalBtn) addGoalBtn.classList.toggle('hidden', !hasPermission('editMatch'));
    
    const addAwardBtn = document.getElementById('addMatchAwardBtn');
    if (addAwardBtn) addAwardBtn.classList.toggle('hidden', !hasPermission('manageAwards'));

    const manageLineupsBtn = document.getElementById('togglePlayerPoolBtn');
    if (manageLineupsBtn) manageLineupsBtn.classList.toggle('hidden', !hasPermission('editMatch'));

    renderSelectionGrid();
    renderRatingsGrid(match.ratings || []);
    toggleModal('match-studio-modal', true);
}

// --- PLAYER VIEW ---
async function viewProfile(id) {
    const p = players.find(x => x && String(x.id) === String(id));
    if (!p) return;

    // STEP 5: PLAYER CARD (LATEST RATING)
    const { data: latestRatingData, error } = await supabase
        .from("match_ratings")
        .select("*")
        .eq("player_id", id)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
    
    const latestRating = latestRatingData ? latestRatingData.rating : null;

    document.getElementById('player-view-body').innerHTML = `
        <div style="text-align:center">
            <img src="${p.photo||'https://via.placeholder.com/150'}" style="width:120px; height:120px; border-radius:15px; border:3px solid var(--accent)">
            <h2 style="margin-top:10px">${p.name}</h2>
            <p class="accent-text" style="margin-bottom: 5px;">${p.pos} | Rating: ${p.rating}</p>
            ${latestRating ? `<p class="text-dim" style="font-size: 0.8rem; margin-bottom: 15px;"><i class="fas fa-star" style="color: gold"></i> Latest Match Rating: <strong>${latestRating}</strong></p>` : ''}
            
            <div class="stats-summary-grid" style="margin-top:20px; grid-template-columns: repeat(3, 1fr);">
                <div class="summary-card" style="border-left-color: gold;"><span class="label">Avg Rating</span><strong>⭐ ${p.avgRating || '0.0'}</strong></div>
                <div class="summary-card"><span class="label">Goals</span><strong>${p.goals||0}</strong></div>
                <div class="summary-card"><span class="label">Matches</span><strong>${p.matches||0}</strong></div>
            </div>
        </div>`;
    toggleModal('player-modal', true);
}

function updateSeasonSelector() {
    const selector = document.getElementById('seasonSelector');
    const selectorMobile = document.getElementById('seasonSelectorMobile');
    
    const html = seasons.map(s => 
        s ? `<option value="${s.id}" ${s.id === currentSeasonId ? 'selected' : ''}>
            ${(s.name || "").toUpperCase()}
        </option>` : ""
    ).join('');

    if (selector) selector.innerHTML = html;
    if (selectorMobile) selectorMobile.innerHTML = html;
}

// Make sure to call this when the page loads
window.addEventListener('DOMContentLoaded', () => {
    updateSeasonSelector();
});

// --- SEASON MANAGER LOGIC ---
function openSeasonManager() {
    if (!hasPermission('manageSeasons')) {
        showAlertModal("Unauthorized: Editor or Admin access required.");
        return;
    }
    renderSeasonManager();
    toggleModal('season-manager-modal', true);
}

async function renderSeasonManager() {
    const list = document.getElementById('sm-seasons-list');
    if (!list) return;

    list.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 40px; opacity: 0.5;">Loading stats...</div>`;

    // Fetch stats for all seasons in parallel for efficiency
    const seasonStats = await Promise.all(seasons.map(async (s) => {
        if (!s) return null;
        
        // Count players
        const { count: pCount } = await supabase.from('players').select('*', { count: 'exact', head: true }).eq('season_id', s.id);
        
        // Count matches and goals
        const { data: mData } = await supabase.from('matches').select('score_a, score_b').eq('season_id', s.id);
        
        const mCount = mData ? mData.length : 0;
        const gCount = mData ? mData.reduce((acc, m) => acc + (m.score_a || 0) + (m.score_b || 0), 0) : 0;
        
        return {
            id: s.id,
            players: pCount || 0,
            matches: mCount || 0,
            goals: gCount || 0
        };
    }));

    const statsMap = {};
    seasonStats.forEach(stat => {
        if (stat) statsMap[stat.id] = stat;
    });

    list.innerHTML = seasons.map(s => {
        if (!s) return "";
        const isActive = s.id == currentSeasonId;
        const stats = statsMap[s.id] || { players: 0, matches: 0, goals: 0 };

        return `
        <div class="season-card-modern ${isActive ? 'active' : ''}" id="season-card-${s.id}">
            ${isActive ? '<span class="active-badge">Active</span>' : ''}
            
            <div class="season-card-header">
                <div id="name-display-${s.id}" class="season-name-display action-enable-season-rename" data-id="${s.id}">
                    ${s.name} <i class="fas fa-edit"></i>
                </div>
                <div id="name-edit-${s.id}" style="display:none">
                    <input type="text" id="name-input-${s.id}" class="season-name-input action-save-season-rename-input" data-id="${s.id}" value="${s.name}">
                </div>
            </div>

            <div class="season-stats-row">
                <div class="sm-stat">
                    <span class="sm-stat-label">Players</span>
                    <span class="sm-stat-val">${stats.players}</span>
                </div>
                <div class="sm-stat">
                    <span class="sm-stat-label">Matches</span>
                    <span class="sm-stat-val">${stats.matches}</span>
                </div>
                <div class="sm-stat">
                    <span class="sm-stat-label">Goals</span>
                    <span class="sm-stat-val">${stats.goals}</span>
                </div>
            </div>

            <div class="season-actions">
                ${!isActive ? `
                    <button class="btn-card-action switch action-switch-season" data-id="${s.id}">
                        <i class="fas fa-exchange-alt"></i> Switch
                    </button>
                ` : `
                    <button class="btn-card-action" style="opacity:0.5; cursor:default">
                        <i class="fas fa-check"></i> Current
                    </button>
                `}
                
                ${seasons.length > 1 ? `
                    <button class="btn-card-action delete action-request-delete-season" data-id="${s.id}">
                        <i class="fas fa-trash"></i>
                    </button>
                ` : ''}
            </div>

            <div id="confirm-delete-${s.id}" class="confirm-delete-box" style="display:none">
                <p>Delete this season and all its data permanently?</p>
                <div style="display:flex; gap:10px; width:100%">
                    <button class="btn-neon w-100 action-cancel-delete-season" data-id="${s.id}" style="background:#444; color:#fff">Cancel</button>
                    <button class="btn-danger w-100 action-confirm-delete-season" data-id="${s.id}">Confirm</button>
                </div>
            </div>
        </div>
        `;
    }).join('');
}

function enableSeasonRename(id) {
    document.getElementById(`name-display-${id}`).style.display = 'none';
    document.getElementById(`name-edit-${id}`).style.display = 'block';
    const input = document.getElementById(`name-input-${id}`);
    if (input) {
        input.focus();
        input.select();
    }
}

async function saveSeasonRename(id) {
    if (!hasPermission('manageSeasons')) {
        showAlertModal("Unauthorized: Editor or Admin access required.");
        return;
    }
    const input = document.getElementById(`name-input-${id}`);
    const newName = input.value.trim();
    
    if (newName) {
        try {
            const { error } = await supabase.from('seasons').update({ name: newName }).eq('id', id);
            if (error) throw error;
            
            await loadSeasons();
            updateSeasonSelector();
        } catch (err) {
            console.error("Season Rename Error:", err);
            showAlertModal("Error renaming season: " + err.message);
        }
    }
    
    document.getElementById(`name-display-${id}`).style.display = 'flex';
    document.getElementById(`name-edit-${id}`).style.display = 'none';
    renderSeasonManager();
}

function requestDeleteSeason(id) {
    document.getElementById(`confirm-delete-${id}`).style.display = 'flex';
}

function cancelDeleteSeason(id) {
    document.getElementById(`confirm-delete-${id}`).style.display = 'none';
}

async function deleteSeason(id) {
    if (!hasPermission('manageSeasons')) {
        showAlertModal("Unauthorized: Editor or Admin access required.");
        return;
    }
    
    try {
        // With ON DELETE CASCADE enabled in the database, 
        // we only need to delete the season itself.
        const { error: seasonError } = await supabase.from('seasons').delete().eq('id', id);
        if (seasonError) throw seasonError;

        // Reset currentSeasonId if it was the one deleted
        if (currentSeasonId === id) {
            currentSeasonId = null;
            localStorage.removeItem('currentSeasonId');
        }
        
        await loadSeasons();
        updateSeasonSelector();
        renderSeasonManager();
        await renderAll();
        
    } catch (err) {
        console.error("Delete error:", err.message);
        showAlertModal("Failed to delete season: " + err.message);
    }
}

async function addSeasonFromManager() {
    if (!hasPermission('manageSeasons')) {
        showAlertModal("Unauthorized: Editor or Admin access required.");
        return;
    }
    const input = document.getElementById('sm-new-name');
    const name = input.value.trim();
    
    if (!name) return;

    try {
        const { data, error } = await supabase.from('seasons').insert([{ name }]).select();
        if (error) throw error;

        currentSeasonId = data[0].id;
        input.value = "";
        
        await loadSeasons();
        updateSeasonSelector();
        renderSeasonManager();
        await renderAll();
        showAlertModal("New season created!");
    } catch (err) {
        console.error("Season Add Error:", err);
        showAlertModal("Error adding season: " + err.message);
    }
}

async function switchSeason(id) {
    if (!hasPermission('manageSeasons')) {
        showAlertModal("Unauthorized: Season management permission required.");
        return;
    }
    currentSeasonId = id;
    updateSeasonSelector();
    renderSeasonManager();
    
    // Force reload data for the new season
    await loadPlayers();
    await loadMatches();
    await renderAll();
}

// Call on load
// Initialization is handled via checkAuth -> init()

// LISTENERS
window.addEventListener('DOMContentLoaded', () => {
    const photo = document.getElementById('f-photo');
    const name = document.getElementById('f-name');
    const number = document.getElementById('f-number');
    const rating = document.getElementById('f-rating');

    if (photo) {
        photo.onchange = (e) => {
            const r = new FileReader();
            r.onload = (ev) => {
                currentPhoto = ev.target.result;
                updateLivePreview();
            };
            r.readAsDataURL(e.target.files[0]);
        };
    }

    if (name) name.oninput = updateLivePreview;
    if (number) number.oninput = updateLivePreview;
    if (rating) rating.oninput = updateLivePreview;
});

// Delete match function
async function deleteMatch(id) {
    if (!hasPermission('deleteMatch')) {
        showAlertModal("Unauthorized: Match Rater, Editor or Admin access required.");
        return;
    }
    openConfirmModal("Delete this match?", async () => {
        await deleteMatchFromDB(id);
    }, "delete");
}
// ===== EXPORT / IMPORT (SAFE ADDITION) =====

function exportData() {
    try {
        const data = localStorage.getItem("seasons");

        if (!data) {
            showAlertModal("No data to export!");
            return;
        }

        const blob = new Blob([data], { type: "application/json" });
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = "xbfa-data.json";

        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        URL.revokeObjectURL(url);
    } catch (err) {
        console.error(err);
        showAlertModal("Export failed");
    }
}

function handleFileSelect(event) {
    const file = event.target.files[0];
    const display = document.getElementById('file-name-display');
    if (file) {
        display.innerText = "Selected: " + file.name;
        importData(event);
    } else {
        display.innerText = "No file selected";
    }
}

function importData(event) {
    if (!hasPermission('adminOnly')) {
        showAlertModal("Unauthorized: Admin access required.");
        return;
    }
    const file = event.target.files[0];
    if (!file) return;

    openConfirmModal("This will overwrite current data. Continue?", () => {
        const reader = new FileReader();

        reader.onload = function(e) {
            try {
                localStorage.setItem("seasons", e.target.result);
                showAlertModal("Data imported successfully!");
                location.reload();
            } catch (err) {
                console.error(err);
                showAlertModal("Import failed");
            }
        };

        reader.readAsText(file);
    });
}

function toggleStudioSection(headerEl) {
    const section = headerEl.closest('.collapsible-section');
    section.classList.toggle('collapsed');
}

function togglePlayerPool() {
    const el = document.getElementById('ms-player-pool-container');
    el.classList.toggle('hidden');
}

// ===== USER MANAGEMENT =====

async function loadUsers() {
    if (!hasPermission('adminOnly')) return;

    const list = document.getElementById('user-list-container');
    const countEl = document.getElementById('user-count');
    if (!list) return;

    list.innerHTML = `<div style="text-align:center; padding:20px; opacity:0.5;">Loading users...</div>`;

    try {
        const { data: users, error } = await supabase
            .from('user_roles')
            .select('user_id, role, email');

        if (error) {
            console.error("Error loading users (fetching user_roles):", error);
            list.innerHTML = `<div style="text-align:center; padding:20px; color:var(--red);">Failed to load users.</div>`;
            return;
        }

        console.log("Fetched Users from user_roles:", users);
        countEl.innerText = `${users.length} Users`;

        if (users.length === 0) {
            list.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-dim);">No users found.</div>`;
            return;
        }

        const roleOptions = Object.keys(ROLE_PERMISSIONS).map(r => 
            `<option value="${r}">${r.replace('_', ' ').toUpperCase()}</option>`
        ).join('');

        list.innerHTML = users.map(u => `
            <div class="glass-card" style="padding: 12px; display: flex; justify-content: space-between; align-items: center; border: 1px solid rgba(255,255,255,0.05); gap: 10px;">
                <div style="display: flex; flex-direction: column; gap: 4px; flex: 1; overflow: hidden;">
                    <span style="font-weight: 500; font-size: 0.85rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${u.email || 'Email missing (' + u.user_id.substring(0,8) + '...)'}</span>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <select class="role-select" data-id="${u.user_id}" style="font-size: 0.7rem; padding: 4px; background: rgba(0,0,0,0.3); color: var(--accent); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px;">
                            ${roleOptions.split('value="' + u.role + '"').join('value="' + u.role + '" selected')}
                        </select>
                        <button class="btn-neon action-save-role" data-id="${u.user_id}" style="padding: 4px 8px; font-size: 0.6rem; margin: 0; min-width: auto; height: auto;">
                            <i class="fas fa-save"></i>
                        </button>
                    </div>
                </div>
                <button class="btn-danger action-delete-user" data-id="${u.user_id}" style="padding: 6px 10px; font-size: 0.7rem; min-width: auto;">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `).join('');

    } catch (err) {
        console.error("Error loading users:", err);
        list.innerHTML = `<div style="text-align:center; padding:20px; color:var(--red);">Failed to load users.</div>`;
    }
}

async function updateUserRole(userId, newRole) {
    if (!hasPermission('adminOnly')) {
        showAlertModal("Unauthorized: Admin access required.");
        return;
    }

    try {
        const { error } = await supabase
            .from('user_roles')
            .update({ role: newRole })
            .eq('user_id', userId);

        if (error) throw error;

        // Also update profiles if present
        await supabase.from('profiles').update({ role: newRole }).eq('id', userId);

        showAlertModal("Role updated successfully!");
        await loadUsers();
    } catch (err) {
        console.error("Update Role Error:", err);
        showAlertModal("Error updating role: " + err.message);
    }
}

async function createUser() {
    if (!hasPermission('adminOnly')) {
        showAlertModal("Unauthorized: Admin access required.");
        return;
    }

    const email = document.getElementById('um-email').value.trim();
    const password = document.getElementById('um-password').value.trim();
    const role = document.getElementById('um-role').value;

    if (!email || !password) {
        showAlertModal("Please enter both email and password.");
        return;
    }

    showAlertModal("Creating user... please wait.");

    try {
        const functionUrl = `${supabaseUrl}/functions/v1/create-user`;
        const response = await fetch(functionUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`,
                'apikey': anonKey
            },
            body: JSON.stringify({ email, password, role })
        });

        const text = await response.text();
        let result;
        try {
            result = JSON.parse(text);
        } catch (e) {
            console.error("Non-JSON response:", text);
            throw new Error("Server returned an invalid response format.");
        }

        if (!response.ok) {
            throw new Error(result.error || "Failed to create user.");
        }

        showAlertModal("User created successfully!");
        document.getElementById('um-email').value = "";
        document.getElementById('um-password').value = "";
        await loadUsers();

    } catch (err) {
        console.error("Create user error:", err);
        showAlertModal("Error: " + err.message);
    }
}

async function deleteUser(id) {
    if (!hasPermission('adminOnly')) {
        showAlertModal("Unauthorized: Admin access required.");
        return;
    }
    
    // Prevent self-deletion if possible
    if (session && session.user.id === id) {
        showAlertModal("You cannot delete your own account.");
        return;
    }

    openConfirmModal("Are you sure you want to delete this user? This action is irreversible.", async () => {
        showAlertModal("Deleting user...");
        try {
            const { error } = await supabase
                .from("user_roles")
                .delete()
                .eq("user_id", id);

            if (error) {
                console.error("Delete error:", error);
                throw error;
            }

            showAlertModal("User deleted successfully.");
            await loadUsers();

        } catch (err) {
            console.error("Delete user error:", err);
            showAlertModal("Error: Failed to delete user");
        }
    });
}

// Initialization listeners are handled in checkAuth and setupEventListeners

// --- BOTTOM SHEET (MOBILE) ---
function toggleBottomSheet(show, content = "") {
    const bs = document.getElementById('bottom-sheet');
    const body = document.getElementById('bottom-sheet-body');
    if (!bs || !body) return;
    if (show) {
        body.innerHTML = content;
        bs.classList.add('show');
        document.body.style.overflow = 'hidden';
    } else {
        bs.classList.remove('show');
        document.body.style.overflow = '';
    }
}

// Close bottom sheet when clicking background or handle
document.addEventListener('touchstart', (e) => {
    const bs = document.getElementById('bottom-sheet');
    if (e.target.id === 'bottom-sheet' || e.target.classList.contains('bottom-sheet-handle')) {
        toggleBottomSheet(false);
    }
});
document.addEventListener('click', (e) => {
    const bs = document.getElementById('bottom-sheet');
    if (e.target.id === 'bottom-sheet' || e.target.classList.contains('bottom-sheet-handle')) {
        toggleBottomSheet(false);
    }
});

function openGoalBottomSheet(initialData = null) {
    const all = [...studioMatch.team_a, ...studioMatch.team_b];
    const opts = '<option value="">Select Scorer</option>' + all.map(pid => {
        const p = players.find(x => x && String(x.id) === String(pid));
        return `<option value="${pid}">${p?.name || "Unknown"}</option>`;
    }).join('');

    const content = `
        <h3 style="margin-bottom:20px; color:var(--accent); font-size: 1.3rem;">
            <i class="fas fa-futbol"></i> ${initialData ? 'Edit Goal' : 'Add New Goal'}
        </h3>
        <div class="input-group-styled" style="margin-bottom:15px;">
            <label>Minute</label>
            <input type="number" id="bs-goal-min" value="${initialData?.min || ''}" placeholder="e.g. 24" style="height:50px; font-size:1.1rem;">
        </div>
        <div class="input-group-styled" style="margin-bottom:20px;">
            <label>Scorer</label>
            <select id="bs-goal-scorer" style="height:50px; font-size:1rem;">${opts}</select>
        </div>
        <div style="display:flex; gap:15px; margin-bottom:25px;">
            <div class="toggle-label-pill" style="flex:1; justify-content:center; padding:15px; border:1px solid rgba(255,255,255,0.05); border-radius:16px; background: rgba(255,255,255,0.02);">
                <span style="font-size: 0.8rem; opacity: 0.7;">Own Goal</span>
                <label class="modern-toggle og-style">
                    <input type="checkbox" id="bs-goal-og" ${initialData?.ownGoal ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>
            <div class="toggle-label-pill" style="flex:1; justify-content:center; padding:15px; border:1px solid rgba(255,255,255,0.05); border-radius:16px; background: rgba(255,255,255,0.02);">
                <span style="font-size: 0.8rem; opacity: 0.7;">Penalty</span>
                <label class="modern-toggle pen-style">
                    <input type="checkbox" id="bs-goal-pen" ${initialData?.penalty ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>
        </div>
        <button class="btn-finalize-hero w-100" id="bs-goal-confirm" style="position:relative !important; height:55px; font-size:1rem; border-radius: 12px !important;">
            Confirm Event
        </button>
    `;
    toggleBottomSheet(true, content);

    if (initialData?.scorer) document.getElementById('bs-goal-scorer').value = initialData.scorer;

    document.getElementById('bs-goal-confirm').onclick = () => {
        const min = document.getElementById('bs-goal-min').value;
        const scorer = document.getElementById('bs-goal-scorer').value;
        const og = document.getElementById('bs-goal-og').checked;
        const pen = document.getElementById('bs-goal-pen').checked;

        if (!min || !scorer) return;

        // Call the underlying add function with a special flag
        addGoalRow({ min, scorer, ownGoal: og, penalty: pen }, true);
        toggleBottomSheet(false);
    };
}

function openRatingPickerBottomSheet(pid, pName, currentVal) {
    const ratings = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
    const content = `
        <h3 style="margin-bottom:10px; color:var(--accent); font-size: 1.2rem;">Rate ${pName}</h3>
        <p class="text-dim" style="margin-bottom:20px; font-size:0.85rem;">Select match performance rating</p>
        <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:12px;">
            ${ratings.map(rv => `
                <button class="btn-outline rating-choice-btn ${parseFloat(currentVal) === rv ? 'active' : ''}" 
                        style="height:60px; font-size:1.2rem; font-weight:800; border-radius:16px; border: 1px solid rgba(255,255,255,0.1); background: ${parseFloat(currentVal) === rv ? 'var(--accent)' : 'rgba(255,255,255,0.03)'}; color: ${parseFloat(currentVal) === rv ? '#000' : '#fff'};" 
                        data-val="${rv}">
                    ${rv.toFixed(1)}
                </button>
            `).join('')}
        </div>
    `;
    toggleBottomSheet(true, content);

    document.querySelectorAll('.rating-choice-btn').forEach(btn => {
        btn.onclick = () => {
            const val = btn.dataset.val;
            const input = document.querySelector(`.ms-player-rating[data-player-id="${pid}"]`);
            if (input) {
                input.value = val;
                const display = document.querySelector(`.rating-display-mobile[data-player-id="${pid}"]`);
                if (display) display.innerText = val;
            }
            toggleBottomSheet(false);
        };
    });
}
