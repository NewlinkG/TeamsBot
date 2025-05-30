import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter, Routes, Route } from "react-router-dom";
import './index.css';
import TicketsTab from './TicketsTab';       // ✅ this was missing
import CommentModal from './CommentModal';
import reportWebVitals from './reportWebVitals';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <HashRouter>
      <Routes>
        <Route path="/" element={<TicketsTab />} />
        <Route path="/comment" element={<CommentModal />} />
      </Routes>
    </HashRouter>
  </React.StrictMode>
);

reportWebVitals();
