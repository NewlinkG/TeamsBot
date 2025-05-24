import React, { useEffect, useState } from "react";
import * as microsoftTeams from "@microsoft/teams-js";
import axios from "axios";

export default function TicketsTab() {
  const [email, setEmail] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState("default");
  const [filterState, setFilterState] = useState("active");

  const stateIcons = {
    new: "🆕",
    open: "🛠",
    "pending close": "🕓",
    "pending reminder": "📅",
    closed: "✅",
    removed: "🗑"
  };

  const isActiveState = (state) =>
    ["new", "open", "pending close", "pending reminder"].includes(state?.toLowerCase());


  useEffect(() => {
    microsoftTeams.app.initialize().then(() => {
      microsoftTeams.app.getContext().then(async (context) => {
        const upn = context.user.userPrincipalName;
        const userEmail = upn.replace(/@.*$/, "@newlink-group.com");
        setEmail(userEmail);
        setTheme(context.app?.theme || "default");

        // 👇 Determine what to fetch based on filter
        const openOnly = filterState === "active";
        const res = await axios.get(
          `/api/tickets?email=${encodeURIComponent(userEmail)}&openOnly=${openOnly}`
        );
        setTickets(res.data || []);
        setLoading(false);
      });

      microsoftTeams.app.registerOnThemeChangeHandler((newTheme) => {
        setTheme(newTheme);
      });
    });
  }, [filterState]);

  if (loading) return <p>Loading...</p>;

  return (
    <div className={`tab-container ${theme}`} style={{ padding: "1rem", fontFamily: "Segoe UI" }}>
      <h2>🎫 My Tickets</h2>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "1rem" }}>
        <div>
          <label>Filter: </label>
          <select value={filterState} onChange={(e) => setFilterState(e.target.value)}>
            <option value="active">🛠 Active</option>
            <option value="closed">✅ Closed</option>
            <option value="all">📋 All</option>
          </select>
        </div>
      </div>
      {tickets.length === 0 ? (
        <p>No tickets found for {email}.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th>ID</th>
              <th>Title</th>
              <th>Status</th>
              <th>Owner</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tickets
              .filter((t) => {
                const state = t.state?.toLowerCase();
                if (filterState === "active") return isActiveState(state);
                if (filterState === "closed") return ["closed", "removed"].includes(state);
                return true; // all
              })
              .map((t) => (
                <tr key={t.id} style={{ opacity: t.state?.toLowerCase() === "closed" ? 0.5 : 1 }}>
                  <td>{t.id}</td>
                  <td>{t.title}</td>
                  <td>
                    <span
                      style={{ whiteSpace: "nowrap", position: "relative", display: "inline-block" }}
                    >
                      {stateIcons[t.state?.toLowerCase()] || ""}

                      <span
                        style={{
                          visibility: "hidden",
                          backgroundColor: "#333",
                          color: "#fff",
                          textAlign: "center",
                          borderRadius: "4px",
                          padding: "4px 8px",
                          position: "absolute",
                          zIndex: 1,
                          bottom: "125%", // above the icon
                          left: "50%",
                          transform: "translateX(-50%)",
                          whiteSpace: "nowrap",
                          fontSize: "12px"
                        }}
                        className="hover-tooltip"
                      >
                        {t.state?.charAt(0).toUpperCase() + t.state?.slice(1)}
                      </span>
                    </span>
                  </td>
                  <td>{t.owner ? `${t.owner.firstname} ${t.owner.lastname || ""}` : "—"}</td>
                  <td>
                    <a href={`https://helpdesk.newlink-group.com/#ticket/zoom/${t.id}`} target="_blank" rel="noreferrer">🔗</a>&nbsp;
                    <button onClick={() => promptComment(t.id)}>✏️</button>&nbsp;
                    {t.state?.toLowerCase() !== "closed" && (
                      <button onClick={() => closeTicket(t.id)}>✅</button>
                    )}
                  </td>
                </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  function promptComment(ticketId) {
    const comment = prompt(`Comment for ticket #${ticketId}:`);
    if (!comment) return;
    axios.post(`/api/tickets/${ticketId}/comment`, { email, comment }).then(() => {
      alert("Comment added.");
    });
  }

  function closeTicket(ticketId) {
    if (!window.confirm(`Close ticket #${ticketId}?`)) return;
    axios.post(`/api/tickets/${ticketId}/close`, { email }).then(() => {
      alert("Ticket closed.");
      setTickets(tickets.map(t =>
        t.id === ticketId ? { ...t, state: "closed" } : t
      ));
    });
  }
}