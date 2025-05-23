import React, { useEffect, useState } from "react";
import * as microsoftTeams from "@microsoft/teams-js";
import axios from "axios";

export default function TicketsTab() {
  const [email, setEmail] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    microsoftTeams.app.initialize().then(() => {
      microsoftTeams.app.getContext().then(async (context) => {
        const upn = context.user.userPrincipalName;
        const userEmail = upn.replace(/@.*$/, "@newlink-group.com");
        setEmail(userEmail);
        const res = await axios.get(`/api/tickets?email=${encodeURIComponent(userEmail)}`);
        setTickets(res.data || []);
        setLoading(false);
      });
    });
  }, []);

  if (loading) return <p>Loading...</p>;

  return (
    <div style={{ padding: "1rem", fontFamily: "Segoe UI" }}>
      <h2>🎫 My Tickets</h2>
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
            {tickets.map((t) => (
              <tr key={t.id}>
                <td>{t.id}</td>
                <td>{t.title}</td>
                <td>{t.state}</td>
                <td>{t.owner ? `${t.owner.firstname} ${t.owner.lastname || ""}` : "—"}</td>
                <td>
                  <a href={`https://helpdesk.newlink-group.com/${t.id}`} target="_blank" rel="noreferrer">🔗</a>&nbsp;
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