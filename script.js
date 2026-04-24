import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const user = localStorage.getItem("loggedInUser");
const userRole = localStorage.getItem("userRole") || "admin";

// Centralized Data Storage
let seasons = [];
let players = [];
let matches = [];
let currentSeasonId = null;
let currentSeasonName = "";

if (!user) {
    window.location.href = "login.html";
}


// --- STATE MANAGEMENT ---
let studioMatch = { teamA: [], teamB: [], events: [] };
let currentPhoto = "";

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
    const { data, error } = await supabase.from('players').select('*');
    if (error) {
        console.error("Error loading players:", error);
        players = [];
    } else {
        players = data || [];
    }
}

async function loadMatches() {
    if (!currentSeasonId) return;
    const { data, error } = await supabase.from('matches').select('*, match_ratings(*)').eq('season_id', currentSeasonId);
    if (error) {
        console.error("Error loading matches:", error);
        matches = [];
    } else {
        matches = (data || []).map(m => ({
            ...m,
            ratings: (m.match_ratings || []).map(r => ({
                playerId: r.player_id,
                rating: r.rating
            }))
        }));
    }
}

async function savePlayerToDB(player) {
    if (!player) return;
    const { id, ...playerData } = player;
    
    if (id && String(id).length > 20) { // Check if it's a UUID
        const { error } = await supabase.from('players').update(playerData).eq('id', id);
        if (error) console.error("Error updating player:", error);
    } else {
        const { error } = await supabase.from('players').insert([playerData]);
        if (error) console.error("Error inserting player:", error);
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
    const { id, ratings, ...matchData } = match;
    matchData.season_id = currentSeasonId;

    let matchId = id;
    if (id && String(id).length > 20) {
        const { error } = await supabase.from('matches').update(matchData).eq('id', id);
        if (error) console.error("Error updating match:", error);
    } else {
        delete matchData.id;
        const { data, error } = await supabase.from('matches').insert([matchData]).select();
        if (error) {
            console.error("Error inserting match:", error);
            return;
        }
        matchId = data[0].id;
    }

    // Handle ratings
    if (ratings) {
        await supabase.from('match_ratings').delete().eq('match_id', matchId);
        if (ratings.length > 0) {
            const ratingsToInsert = ratings.map(r => ({
                match_id: matchId,
                player_id: r.playerId,
                rating: r.rating
            }));
            const { error: rError } = await supabase.from('match_ratings').insert(ratingsToInsert);
            if (rError) console.error("Error inserting ratings:", rError);
        }
    }

    await loadMatches();
    await recalculateStats();
    renderAll();
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
function recalculateStats() {
    const activeMatches = matches;
    const activePlayers = players;

    // Reset stats for all active players
    activePlayers.forEach(p => {
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
        const uniqueParticipants = [...new Set([...(m.teamA || []), ...(m.teamB || [])])];
        uniqueParticipants.forEach(pid => {
            const p = activePlayers.find(pl => pl && String(pl.id) === String(pid));
            if (p) p.matches = (p.matches || 0) + 1;
        });

        // 3. Ratings
        if (m.ratings) {
            m.ratings.forEach(r => {
                const p = activePlayers.find(pl => pl && String(pl.id) === String(r.playerId));
                if (p && r.rating) {
                    p.totalRatingScore += parseFloat(r.rating);
                    p.ratingCount += 1;
                    p.latestRating = r.rating;
                }
            });
        }
    });

    activePlayers.forEach(p => {
        if (p.ratingCount > 0) {
            p.avgRating = (p.totalRatingScore / p.ratingCount).toFixed(1);
        }
        delete p.totalRatingScore;
        delete p.ratingCount;
    });
}


// --- NAVIGATION ---
function showPage(id) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    
    // Sidebar Nav
    document.querySelectorAll('.nav-links li').forEach(li => li.classList.remove('active'));
    const navItem = document.getElementById('nav-'+id);
    if(navItem) navItem.classList.add('active');

    // Bottom Nav
    document.querySelectorAll('.bottom-nav-item').forEach(item => item.classList.remove('active'));
    const bnavItem = document.getElementById('bnav-'+id);
    if(bnavItem) bnavItem.classList.add('active');

    renderAll();
    window.scrollTo(0, 0); // Reset scroll on page switch
}

// --- RENDER CORE ---
async function renderAll() {
    await loadPlayers();
    await loadMatches();
    await renderDashboard();
    renderSquad();
    renderMatches();
    renderLeaderboards();
    await renderAwards();

    // UI protection: keep settings visible but hide admin-only controls
    const isAdmin = userRole === "admin";
    
    // 1. Header / Common Buttons
    document.querySelectorAll('.header-actions .btn-neon').forEach(btn => {
        btn.classList.toggle('hidden', !isAdmin);
    });

    // 2. Global Role-Based Visibility
    document.querySelectorAll('.admin-only').forEach(el => {
        el.classList.toggle('hidden', !isAdmin);
    });

    document.querySelectorAll('.visitor-only').forEach(el => {
        el.classList.toggle('hidden', isAdmin);
    });
}

// FIX 1: DASHBOARD STATS (Structured HTML Blocks)
async function renderDashboard() {
    const totalGoals = players.reduce((s,p) => s + (p.goals || 0), 0);
    
    document.getElementById('dashboard-stats').innerHTML = `
        <div class="summary-card">
            <span class="label">Matches Played</span>
            <span class="value">${matches.length}</span>
        </div>
        <div class="summary-card">
            <span class="label">Total Squad Goals</span>
            <span class="value">${totalGoals}</span>
        </div>
        <div class="summary-card">
            <span class="label">Active Players</span>
            <span class="value">${players.length}</span>
        </div>
    `;

// --- MVP FIX (SEASON BASED) ---
const { data: mvpAward, error } = await supabase.from('awards').select('*').eq('season_id', currentSeasonId).ilike('name', '%MVP%').single();
const mvpId = mvpAward ? mvpAward.player_id : null;

let star = null;

// If MVP award is found → use it
if (mvpId) {
    star = players.find(p => p && String(p.id) === String(mvpId));
} 
// Otherwise fallback to top scorer
else {
    star = [...players].sort((a,b) => (b && a ? (b.goals||0) - (a.goals||0) : 0))[0];
}

if(star) {
    document.getElementById('dash-mvp-card').innerHTML = createCardHTML(star);
}
    const latest = matches[matches.length - 1];
    if(latest) {
        document.getElementById('latest-match-hero').innerHTML = `
            <div class="match-card" style="width:100%" onclick="viewMatchDetail('${latest.id}')">
                <div class="match-score">${latest.scoreA} - ${latest.scoreB}</div>
                <div class="match-meta">${latest.title} • ${latest.date}</div>
            </div>`;
    }
}

// FIX 3: MATCH LIST (Structured Cards)
function renderMatches() {
    const list = document.getElementById('match-history-list');
    list.innerHTML = matches.slice().reverse().map(m => `
        <div class="match-card" style="position:relative">
            <div onclick="viewMatchDetail('${m.id}')" style="cursor:pointer">
                <div class="match-score">${m.scoreA} - ${m.scoreB}</div>
                <div class="match-meta">${m.title} • ${m.date}</div>
            </div>
            ${userRole === "admin" ? `
            <div style="position:absolute; top:10px; right:10px; display:flex; gap:8px">
                <button onclick="event.stopPropagation(); deleteMatch('${m.id}')" style="background:none; border:none; color:#ff4d4d; cursor:pointer">
                    <i class="fas fa-trash"></i>
                </button>
                <button onclick="event.stopPropagation(); editMatch('${m.id}')" style="background:none; border:none; color:var(--accent); cursor:pointer">
                    <i class="fas fa-edit"></i>
                </button>
            </div>
            ` : ``}
        </div>
    `).join('');
}

// --- MODERN MATCH DETAIL VIEW ---
function viewMatchDetail(id) {
    const m = matches.find(x => x && x.id == id);
    if (!m) return;
    const getP = (pid) => players.find(x => x && x.id == pid)?.name || "Unknown";
    const getRating = (pid) => {
        const r = (m.ratings || []).find(x => String(x.playerId) === String(pid));
        return r ? r.rating : null;
    };

    const renderLineup = (lineup, teamClass) => lineup.map(pid => {
        const rating = getRating(pid);
        return `
            <div class="lineup-player-row ${teamClass}">
                <div class="lineup-player-info">
                    <i class="fas fa-user-circle"></i>
                    <span>${getP(pid)}</span>
                </div>
                ${rating ? `
                    <div class="lineup-player-rating">
                        <i class="fas fa-star"></i> ${rating}
                    </div>
                ` : `<div class="lineup-player-rating" style="opacity:0.2; border:none; background:none; box-shadow:none;">NR</div>`}
            </div>
        `;
    }).join('');

    let html = `
        <span class="close-btn" onclick="toggleModal('match-detail-modal', false)">&times;</span>
        
        <div class="match-header-modern">
            <div class="match-meta">${m.title} • ${m.date}</div>
            <div class="score-display">
                <div class="team-side">
                    <div class="team-name-big" style="color:var(--team-a)">TEAM A</div>
                    <div class="score-num">${m.scoreA}</div>
                </div>
                <div class="vs-badge">VS</div>
                <div class="team-side">
                    <div class="team-name-big" style="color:var(--team-b)">TEAM B</div>
                    <div class="score-num">${m.scoreB}</div>
                </div>
            </div>
        </div>

        <div class="lineup-grid">
            <div class="lineup-column">
                <h4><i class="fas fa-users"></i> Squad A</h4>
                <div class="player-row-container">
                    ${renderLineup(m.teamA, 'team-a')}
                </div>
            </div>
            <div class="lineup-column">
                <h4><i class="fas fa-users"></i> Squad B</h4>
                <div class="player-row-container">
                    ${renderLineup(m.teamB, 'team-b')}
                </div>
            </div>
        </div>

        <div class="detail-timeline-modern">
            <h4><i class="fas fa-history"></i> MATCH EVENTS</h4>
            <div class="timeline-list">
                ${m.events.length > 0 ? m.events.map(ev => `
                    <div class="timeline-event">
                        <div class="event-min">${ev.min}'</div>
                        <div class="event-info">
                            <span class="event-scorer"><strong>${getP(ev.scorer)}</strong> ${ev.ownGoal ? '(OG)' : '<i class="fas fa-futbol"></i>'}</span>
                        </div>
                        <div class="event-team" style="color:${
                            (ev.ownGoal ? (ev.team === 'A' ? 'var(--team-b)' : 'var(--team-a)') : (ev.team === 'A' ? 'var(--team-a)' : 'var(--team-b)'))
                        }">
                            TEAM ${ev.ownGoal ? (ev.team === 'A' ? 'B' : 'A') : ev.team}
                        </div>
                    </div>
                `).join('') : '<p class="text-dim" style="padding:20px">No goals were recorded in this match.</p>'}
            </div>
        </div>

        <div class="awards-grid-modern">
            <div class="award-card-mini">
                <span class="award-label">MVP</span>
                <span class="award-winner">${getP(m.awards.mvp)}</span>
            </div>
            <div class="award-card-mini lvp">
                <span class="award-label">LVP</span>
                <span class="award-winner">${getP(m.awards.lvp)}</span>
            </div>
            <div class="award-card-mini gk">
                <span class="award-label">BEST GK</span>
                <span class="award-winner">${getP(m.awards.gk)}</span>
            </div>
        </div>
    `;
    
    document.getElementById('match-detail-body').innerHTML = html;
    toggleModal('match-detail-modal', true);
}

// FIX 4: AWARDS DISPLAY (Redesigned Modern Cards)
async function renderAwards() {
    const isAdmin = userRole === "admin";

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
            ${isAdmin ? `
            <div class="award-actions-overlay">
                <button class="btn-award-action" onclick="openAwardStudio('${a.id}')">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="btn-award-action delete" onclick="deleteAward('${a.id}')">
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
    if (userRole !== "admin") return;
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

document.getElementById('as-form').onsubmit = async (e) => {
    e.preventDefault();
    if (userRole !== "admin") return;

    const id = document.getElementById('as-id').value;
    const name = document.getElementById('as-name').value.trim();
    const playerId = document.getElementById('as-player').value;

    if (!name || !playerId) return;

    const awardData = { name, player_id: playerId, season_id: currentSeasonId };

    if (id) {
        await supabase.from('awards').update(awardData).eq('id', id);
    } else {
        await supabase.from('awards').insert([awardData]);
    }

    toggleModal('award-studio-modal', false);
    await renderAwards();
};

async function deleteAward(id) {
    if (userRole !== "admin") return;
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
            ${userRole === "admin" ? `
            <div style="position:absolute; top:10px; right:10px; display:flex; gap:8px; z-index:10">
                <button onclick="event.stopPropagation(); deletePlayer('${p.id}')" style="background:none; border:none; color:#ff4d4d; cursor:pointer">
                    <i class="fas fa-trash"></i>
                </button>
                <button onclick="openPlayerStudio('${p.id}')" style="background:none; border:none; color:var(--accent); cursor:pointer">
                    <i class="fas fa-edit"></i>
                </button>
            </div>
            ` : ``}

            <div class="player-stats-meta">
                <div class="rating">${p.rating}</div>
                <div class="pos">${p.pos}</div>
            </div>

            ${p.latestRating ? `
            <div class="card-rating-badge">
                <i class="fas fa-star"></i> ${p.latestRating}
            </div>
            ` : ``}
            
            <!-- Large Background Jersey Number -->
            <div class="card-number ${posClass}">${p.jerseyNumber || ''}</div>

            <img src="${p.photo || 'https://via.placeholder.com/150?text=FC26'}" class="player-img" onclick="viewProfile('${p.id}')">
            <div class="name" onclick="viewProfile('${p.id}')">${p.name}</div>
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
    if (userRole !== "admin") return;
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
    if(show) el.classList.add('show-flex');
    else el.classList.remove('show-flex');
}


async function resetSystem() {
    if (userRole !== "admin") return;
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
    if (userRole !== "admin") return;
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
            document.getElementById('f-number').value = p.jerseyNumber || "";
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
    const jerseyNumber = document.getElementById('f-number').value;
    const pos = document.getElementById('f-pos').value;
    const rating = document.getElementById('f-rating').value;
    document.getElementById('f-rating-val').innerText = rating;
    document.getElementById('ps-preview-container').innerHTML = createCardHTML({name, pos, rating, jerseyNumber, photo: currentPhoto, goals:0, matches:0, id:99});
}

document.getElementById('ps-form').onsubmit = async (e) => {
  e.preventDefault();

  const idInput = document.getElementById('f-id').value;

  const data = {
    name: document.getElementById('f-name').value,
    jerseyNumber: parseInt(document.getElementById('f-number').value) || null,
    pos: document.getElementById('f-pos').value,
    rating: parseInt(document.getElementById('f-rating').value),
    photo: currentPhoto,
  };

  if (idInput) {
      data.id = idInput;
  }

  await savePlayerToDB(data);
  renderSquad();
  toggleModal('player-studio-modal', false);
};

async function init() {
    await loadSeasons();
    updateSeasonSelector();
    await renderAll();
}


// --- MATCH STUDIO HANDLING ---
function openMatchStudio() {
    const isAdmin = userRole === "admin";
    studioMatch = { teamA: [], teamB: [], events: [] };
    window.editingMatchId = null;
    
    document.getElementById('ms-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('ms-date').disabled = !isAdmin;
    
    document.getElementById('ms-title').value = "";
    document.getElementById('ms-title').disabled = !isAdmin;
    
    document.getElementById('goal-events-container-modern').innerHTML = "";
    document.getElementById('ms-awards-container-dynamic').innerHTML = "";
    document.getElementById('ms-ratings-container-dynamic').innerHTML = "";
    
    const finalizeBtn = document.getElementById('ms-finalize-btn');
    if (finalizeBtn) finalizeBtn.classList.toggle('hidden', !isAdmin);
    
    const addGoalBtn = document.querySelector('[onclick="addGoalRow()"]');
    if (addGoalBtn) addGoalBtn.classList.toggle('hidden', !isAdmin);
    
    const addAwardBtn = document.querySelector('[onclick="addAwardRowInStudio()"]');
    if (addAwardBtn) addAwardBtn.classList.toggle('hidden', !isAdmin);

    const manageLineupsBtn = document.querySelector('[onclick="togglePlayerPool()"]');
    if (manageLineupsBtn) manageLineupsBtn.classList.toggle('hidden', !isAdmin);

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
    const isAdmin = userRole === "admin";

    pool.innerHTML = players.map(p => {
        if (!p) return "";
        let state = studioMatch.teamA.some(pid => String(pid) === String(p.id)) ? 'active-a' : (studioMatch.teamB.some(pid => String(pid) === String(p.id)) ? 'active-b' : '');
        return `<button class="player-chip-mini ${state}" ${!isAdmin ? 'disabled' : ''} onclick="cyclePlayer('${p.id}')">${p.name}</button>`;
    }).join('');

    const getPRef = (pid) => players.find(p => p && String(p.id) === String(pid));
    
    const renderChips = (list, team) => list.map(pid => {
        const p = getPRef(pid);
        return `<div class="player-chip-mini active-${team.toLowerCase()}">${p ? p.name : 'Unknown'}</div>`;
    }).join('');

    document.getElementById('lineup-a-list-modern').innerHTML = renderChips(studioMatch.teamA, 'A');
    document.getElementById('lineup-b-list-modern').innerHTML = renderChips(studioMatch.teamB, 'B');

    // Update all award selectors with current squad
    const all = [...studioMatch.teamA, ...studioMatch.teamB];
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
    if (userRole !== "admin") return;
    const inA = studioMatch.teamA.some(x => String(x) === String(id));
    const inB = studioMatch.teamB.some(x => String(x) === String(id));

    if (!inA && !inB) {
        studioMatch.teamA.push(id);
    } else if (inA) {
        studioMatch.teamA = studioMatch.teamA.filter(i => String(i) !== String(id));
        studioMatch.teamB.push(id);
    } else {
        studioMatch.teamB = studioMatch.teamB.filter(i => String(i) !== String(id));
    }
    renderSelectionGrid();
    renderRatingsGrid(studioMatch.ratings || []);
}

function addGoalRow(initialData = null) {
    const isAdmin = userRole === "admin";
    const all = [...studioMatch.teamA, ...studioMatch.teamB];
    const opts = '<option value="">Select Scorer</option>' + all.map(pid => `<option value="${pid}">${players.find(p => p && String(p.id) === String(pid))?.name || "Unknown"}</option>`).join('');
    
    const div = document.createElement('div');
    div.className = "event-card-row timeline-item";
    div.innerHTML = `
        <div style="width: 70px;">
            <input type="number" placeholder="Min" class="m-min" value="${initialData?.min || ''}" style="margin:0; padding:8px;" ${!isAdmin ? 'disabled' : ''}>
        </div>
        <div style="flex: 1;">
            <select class="m-scorer" style="margin:0; padding:8px;" ${!isAdmin ? 'disabled' : ''}>
                ${opts}
            </select>
        </div>
        <div style="width: 100px;">
            <label class="og-toggle" style="display:flex; align-items:center; gap:5px; cursor:pointer;">
                <input type="checkbox" class="m-owngoal" ${initialData?.ownGoal ? 'checked' : ''} ${!isAdmin ? 'disabled' : ''}>
                <span style="font-size:0.8rem;">OG</span>
            </label>
        </div>
        ${isAdmin ? `
        <button class="goal-delete" onclick="this.closest('.timeline-item').remove()" style="background:none; border:none; color:#ff4d4d; cursor:pointer; font-size:1.2rem;">
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
    const isAdmin = userRole === "admin";
    const container = document.getElementById('ms-awards-container-dynamic');
    const all = [...studioMatch.teamA, ...studioMatch.teamB];
    const opts = '<option value="">Select Player</option>' + all.map(pid => `<option value="${pid}">${players.find(p => p && String(p.id) === String(pid))?.name || "Unknown"}</option>`).join('');
    
    const div = document.createElement('div');
    div.className = "award-row-dynamic studio-award-item";
    div.innerHTML = `
        <div style="flex: 1;">
            <input type="text" class="ms-award-label" placeholder="Award Name" value="${label}" style="margin:0; padding:8px;" ${!isAdmin ? 'disabled' : ''}>
        </div>
        <div style="flex: 1;">
            <select class="ms-award-player-select" style="margin:0; padding:8px;" ${!isAdmin ? 'disabled' : ''}>
                ${opts}
            </select>
        </div>
        ${isAdmin ? `
        <button onclick="this.parentElement.remove()" style="background:none; border:none; color:#ff4d4d; cursor:pointer;">
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
    
    const all = [...studioMatch.teamA, ...studioMatch.teamB];
    const isAdmin = userRole === "admin";
    
    if (all.length === 0) {
        container.innerHTML = '<p class="text-dim" style="padding:10px; font-size:0.8rem;">Select players for lineups first.</p>';
        return;
    }
    
    container.innerHTML = all.map(pid => {
        const p = players.find(x => x && String(x.id) === String(pid));
        if (!p) return "";
        const r = existingRatings.find(x => String(x.playerId) === String(pid));
        const val = r ? r.rating : "";
        
        return `
            <div class="rating-row-studio">
                <div class="player-name">
                    <i class="fas fa-user-circle"></i> ${p.name}
                </div>
                <div>
                    <input type="number" step="0.1" min="0" max="5" 
                           class="rating-input-modern ms-player-rating" 
                           data-player-id="${p.id}" 
                           value="${val}" 
                           placeholder="0.0"
                           ${!isAdmin ? 'disabled' : ''}>
                </div>
            </div>
        `;
    }).join('');
}

async function saveMatch() {
    if (userRole !== "admin") return;
    
    const rows = document.querySelectorAll('.timeline-item');
    const events = [];

    rows.forEach(r => {
        const min = parseInt(r.querySelector('.m-min').value);
        const scorer = r.querySelector('.m-scorer').value;
        const ownGoal = r.querySelector('.m-owngoal')?.checked;

        if (!isNaN(min) && scorer) {
            let team;
            if (studioMatch.teamA.some(id => String(id) === String(scorer))) {
                team = 'A';
            } else if (studioMatch.teamB.some(id => String(id) === String(scorer))) {
                team = 'B';
            } else {
                team = 'A'; // fallback
            }
            events.push({ min, team, scorer, ownGoal });
        }
    });

    // calculate score
    let scoreA = 0;
    let scoreB = 0;
    events.forEach(e => {
        if (e.ownGoal) {
            if (e.team === 'A') scoreB++;
            else scoreA++;
        } else {
            if (e.team === 'A') scoreA++;
            else scoreB++;
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
        if (val) {
            ratings.push({
                playerId: input.dataset.playerId,
                rating: parseFloat(val).toFixed(1)
            });
        }
    });

    const data = {
        date: document.getElementById('ms-date').value,
        title: document.getElementById('ms-title').value || "New Match",
        teamA: [...studioMatch.teamA],
        teamB: [...studioMatch.teamB],
        events: events,
        scoreA,
        scoreB,
        awards: awards,
        ratings: ratings
    };

    if (window.editingMatchId) {
        data.id = window.editingMatchId;
    }

    await saveMatchToDB(data);
    toggleModal('match-studio-modal', false);
}

function editMatch(id) {
    const isAdmin = userRole === "admin";
    const match = matches.find(m => m && m.id == id);
    if (!match) return;

    window.editingMatchId = id;
    studioMatch = { 
        teamA: [...match.teamA], 
        teamB: [...match.teamB], 
        events: [...match.events] 
    };

    document.getElementById('ms-date').value = match.date;
    document.getElementById('ms-date').disabled = !isAdmin;
    
    document.getElementById('ms-title').value = match.title;
    document.getElementById('ms-title').disabled = !isAdmin;
    
    document.getElementById('goal-events-container-modern').innerHTML = "";
    match.events.forEach(ev => addGoalRow(ev));

    document.getElementById('ms-awards-container-dynamic').innerHTML = "";
    if (match.awards.mvp) addAwardRowInStudio("MVP", match.awards.mvp);
    if (match.awards.lvp) addAwardRowInStudio("LVP", match.awards.lvp);
    if (match.awards.gk) addAwardRowInStudio("BEST GK", match.awards.gk);

    const finalizeBtn = document.getElementById('ms-finalize-btn');
    if (finalizeBtn) finalizeBtn.classList.toggle('hidden', !isAdmin);
    
    const addGoalBtn = document.querySelector('[onclick="addGoalRow()"]');
    if (addGoalBtn) addGoalBtn.classList.toggle('hidden', !isAdmin);
    
    const addAwardBtn = document.querySelector('[onclick="addAwardRowInStudio()"]');
    if (addAwardBtn) addAwardBtn.classList.toggle('hidden', !isAdmin);

    const manageLineupsBtn = document.querySelector('[onclick="togglePlayerPool()"]');
    if (manageLineupsBtn) manageLineupsBtn.classList.toggle('hidden', !isAdmin);

    renderSelectionGrid();
    renderRatingsGrid(match.ratings || []);
    toggleModal('match-studio-modal', true);
}

// --- PLAYER VIEW ---
function viewProfile(id) {
    const p = players.find(x => x && String(x.id) === String(id));
    if (!p) return;
    document.getElementById('player-view-body').innerHTML = `
        <div style="text-align:center"><img src="${p.photo||'https://via.placeholder.com/150'}" style="width:120px; height:120px; border-radius:15px; border:3px solid var(--accent)">
        <h2 style="margin-top:10px">${p.name}</h2><p class="accent-text">${p.pos} | Rating: ${p.rating}</p>
        <div class="stats-summary-grid" style="margin-top:20px; grid-template-columns: repeat(3, 1fr);">
            <div class="summary-card" style="border-left-color: gold;"><span class="label">Avg Rating</span><strong>⭐ ${p.avgRating || '0.0'}</strong></div>
            <div class="summary-card"><span class="label">Goals</span><strong>${p.goals||0}</strong></div>
            <div class="summary-card"><span class="label">Matches</span><strong>${p.matches||0}</strong></div>
        </div></div>`;
    toggleModal('player-modal', true);
}

function updateSeasonSelector() {
    const selector = document.getElementById('seasonSelector');
    const selectorMobile = document.getElementById('seasonSelectorMobile');
    
    const html = seasons.map(s => 
        s ? `<option value="${s.id}" ${s.id === currentSeasonId ? 'selected' : ''}>
            ${s.name.toUpperCase()}
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
    renderSeasonManager();
    toggleModal('season-manager-modal', true);
}

function renderSeasonManager() {
    const list = document.getElementById('sm-seasons-list');
    if (!list) return;

    list.innerHTML = seasons.map(s => {
        if (!s) return "";
        const isActive = s.id == currentSeasonId;
        const playerCount = (s.players || []).length;
        const matchCount = (s.matches || []).length;
        const goalCount = (s.matches || []).reduce((acc, m) => acc + (m.scoreA || 0) + (m.scoreB || 0), 0);

        return `
        <div class="season-card-modern ${isActive ? 'active' : ''}" id="season-card-${s.id}">
            ${isActive ? '<span class="active-badge">Active</span>' : ''}
            
            <div class="season-card-header">
                <div id="name-display-${s.id}" class="season-name-display" onclick="enableSeasonRename('${s.id}')">
                    ${s.name} <i class="fas fa-edit"></i>
                </div>
                <div id="name-edit-${s.id}" style="display:none">
                    <input type="text" id="name-input-${s.id}" class="season-name-input" value="${s.name}" onblur="saveSeasonRename('${s.id}')" onkeydown="if(event.key==='Enter') saveSeasonRename('${s.id}')">
                </div>
            </div>

            <div class="season-stats-row">
                <div class="sm-stat">
                    <span class="sm-stat-label">Players</span>
                    <span class="sm-stat-val">${playerCount}</span>
                </div>
                <div class="sm-stat">
                    <span class="sm-stat-label">Matches</span>
                    <span class="sm-stat-val">${matchCount}</span>
                </div>
                <div class="sm-stat">
                    <span class="sm-stat-label">Goals</span>
                    <span class="sm-stat-val">${goalCount}</span>
                </div>
            </div>

            <div class="season-actions">
                ${!isActive ? `
                    <button class="btn-card-action switch" onclick="switchSeason('${s.id}')">
                        <i class="fas fa-exchange-alt"></i> Switch
                    </button>
                ` : `
                    <button class="btn-card-action" style="opacity:0.5; cursor:default">
                        <i class="fas fa-check"></i> Current
                    </button>
                `}
                
                ${seasons.length > 1 ? `
                    <button class="btn-card-action delete" onclick="requestDeleteSeason('${s.id}')">
                        <i class="fas fa-trash"></i>
                    </button>
                ` : ''}
            </div>

            <!-- UI CONFIRM DELETE -->
            <div id="confirm-delete-${s.id}" class="confirm-delete-box" style="display:none">
                <p>Delete this season and all its data permanently?</p>
                <div style="display:flex; gap:10px; width:100%">
                    <button class="btn-neon w-100" style="background:#444; color:#fff" onclick="cancelDeleteSeason('${s.id}')">Cancel</button>
                    <button class="btn-danger w-100" onclick="deleteSeason('${s.id}')">Confirm</button>
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
    input.focus();
    input.select();
}

function saveSeasonRename(id) {
    const input = document.getElementById(`name-input-${id}`);
    const newName = input.value.trim();
    
    if (newName) {
        const idx = seasons.findIndex(s => s.id === id);
        if (idx !== -1) {
            seasons[idx].name = newName;
            saveSeasons();
            updateSeasonSelector();
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
    if (userRole !== "admin") return;
    const { error } = await supabase.from('seasons').delete().eq('id', id);
    if (error) {
        console.error("Error deleting season:", error);
        return;
    }
    
    await loadSeasons();
    updateSeasonSelector();
    renderSeasonManager();
    await renderAll();
}

async function addSeasonFromManager() {
    if (userRole !== "admin") return;
    const input = document.getElementById('sm-new-name');
    const name = input.value.trim();
    
    if (!name) return;

    const { data, error } = await supabase.from('seasons').insert([{ name }]).select();
    if (error) {
        console.error("Error adding season:", error);
        return;
    }

    currentSeasonId = data[0].id;
    input.value = "";
    
    await loadSeasons();
    updateSeasonSelector();
    renderSeasonManager();
    await renderAll();
}

async function switchSeason(id) {
    currentSeasonId = id;
    updateSeasonSelector();
    renderSeasonManager();
    await renderAll();
}

// Call on load
window.addEventListener('DOMContentLoaded', init);
window.addEventListener('DOMContentLoaded', updateSeasonSelector);  

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
    if (userRole !== "admin") return;
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
    if (userRole !== "admin") return;
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

window.exportData = exportData;
window.importData = importData;
window.handleFileSelect = handleFileSelect;
// ===== USER MANAGEMENT (SUPABASE) =====

async function getUsers() {
    const { data, error } = await supabase.from('profiles').select('*');
    if (error) console.error("Error fetching users:", error);
    return data || [];
}

async function createUser() {
    if (userRole !== "admin") return;
    const username = document.getElementById('uc-username').value.trim();
    const password = document.getElementById('uc-password').value.trim();
    const role = document.getElementById('uc-role').value;

    if (!username || !password) {
        showAlertModal("Enter username and password");
        return;
    }

    const { error } = await supabase.from('profiles').insert([{ username, password, role }]);
    if (error) {
        showAlertModal("Error creating user: " + error.message);
    } else {
        showAlertModal("User created successfully!");
        document.getElementById('uc-username').value = "";
        document.getElementById('uc-password').value = "";
        document.getElementById('uc-role').value = "visitor";
        await renderIdManager();
    }
}

async function renderIdManager() {
    const list = document.getElementById('id-list');
    if (!list) return;

    const users = await getUsers();

    list.innerHTML = users.map((u, i) => `
    <div class="glass-card" style="padding:12px; display:flex; flex-direction:column; gap:8px">
        <div onclick="toggleUserCard(${i})" style="display:flex; justify-content:space-between; align-items:center; cursor:pointer">
            <div>
                <span class="accent-text" style="font-weight:bold">${u.username}</span>
                <span style="font-size:0.7rem; color:var(--text-dim); margin-left:8px">${(u.role || 'visitor').toUpperCase()}</span>
            </div>
            <i class="fas fa-chevron-down" id="arrow-${i}" style="font-size:0.8rem; opacity:0.5; transition:0.3s"></i>
        </div>

        <div id="user-body-${i}" style="display:none; flex-direction:column; gap:12px; margin-top:8px; padding-top:12px; border-top:1px solid rgba(255,255,255,0.05)">
            <div style="display:flex; flex-direction:column; gap:5px">
                <label style="font-size:0.7rem; opacity:0.6">PASSWORD</label>
                <input type="text" id="pwd-${i}" class="input-modern" value="${u.password}" style="margin:0; padding:8px;">
            </div>
            <div style="display:flex; gap:10px">
                <button class="btn-cyan" style="flex:2" onclick="updateUserPassword('${u.id}', ${i})">Update</button>
                <button class="btn-danger" style="flex:1" onclick="deleteUser('${u.id}')">Delete</button>
            </div>
        </div>
    </div>
    `).join('');
}

function toggleUserCard(index) {
    const body = document.getElementById(`user-body-${index}`);
    const arrow = document.getElementById(`arrow-${index}`);

    if (!body) return;

    const isOpen = body.style.display === "flex";

    body.style.display = isOpen ? "none" : "flex";
    arrow.style.transform = isOpen ? "rotate(0deg)" : "rotate(180deg)";
}

async function updateUserPassword(id, index) {
    if (userRole !== "admin") return;
    const newPass = document.getElementById(`pwd-${index}`).value.trim();

    if (!newPass) {
        showAlertModal("Password cannot be empty");
        return;
    }

    const { error } = await supabase.from('profiles').update({ password: newPass }).eq('id', id);
    if (!error) {
        showAlertModal("Password updated!");
    } else {
        showAlertModal("Error updating password: " + error.message);
    }
}

async function deleteUser(id) {
    if (userRole !== "admin") return;
    openConfirmModal("Delete this user?", async () => {
        await supabase.from('profiles').delete().eq('id', id);
        await renderIdManager();
    }, "delete");
}

async function deleteAllUsers() {
    if (userRole !== "admin") return;
    openConfirmModal("Delete ALL users?", async () => {
        await supabase.from('profiles').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await renderIdManager();
    }, "delete");
}

function toggleStudioSection(headerEl) {
    const section = headerEl.closest('.collapsible-section');
    section.classList.toggle('collapsed');
}

function togglePlayerPool() {
    const el = document.getElementById('ms-player-pool-container');
    el.classList.toggle('hidden');
}

// expose globally
window.closeConfirmModal = closeConfirmModal;
window.openConfirmModal = openConfirmModal;
window.showAlertModal = showAlertModal;
window.createUser = createUser;
window.renderIdManager = renderIdManager;
window.updateUserPassword = updateUserPassword;
window.deleteUser = deleteUser;
window.deleteAllUsers = deleteAllUsers;
window.toggleUserCard = toggleUserCard;
window.deleteMatch = deleteMatch;
window.editMatch = editMatch;
window.deletePlayer = deletePlayer;
window.deleteAward = deleteAward;
window.openAwardStudio = openAwardStudio;
window.openPlayerStudio = openPlayerStudio;
window.viewProfile = viewProfile;
window.viewMatchDetail = viewMatchDetail;
window.addSeasonFromManager = addSeasonFromManager;
window.switchSeason = switchSeason;
window.deleteSeason = deleteSeason;
window.resetSystem = resetSystem;
window.toggleModal = toggleModal;
window.showPage = showPage;
window.cyclePlayer = cyclePlayer;
window.addGoalRow = addGoalRow;
window.addAwardRowInStudio = addAwardRowInStudio;
window.saveMatch = saveMatch;
window.togglePlayerPool = togglePlayerPool;
window.toggleStudioSection = toggleStudioSection;
// ===== AUTH =====
function logout() {
    localStorage.removeItem("loggedInUser");
    window.location.href = "login.html";
}

// make it globally accessible
window.logout = logout;

// Ensure role is globally accessible
window.userRole = userRole;