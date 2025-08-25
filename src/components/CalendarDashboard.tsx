import { useState, useEffect } from 'react'
import { useStytch } from '@stytch/react'

interface Calendar {
  name: string
  url: string
  status: string
  refreshInterval: number
}

interface CalendarEvent {
  id: string
  summary: string
  description?: string
  start: string
  end: string
  location?: string
  calendarName: string
}

function CalendarDashboard() {
  const stytch = useStytch()
  const [calendars, setCalendars] = useState<Calendar[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newCalendar, setNewCalendar] = useState({
    name: '',
    url: '',
    refreshInterval: 60
  })

  useEffect(() => {
    fetchCalendars()
    fetchUpcomingEvents()
  }, [])

  const getAuthHeaders = async () => {
    const session = await stytch.session.getSync()
    return {
      'Authorization': `Bearer ${(session as any)?.session_jwt}`,
      'Content-Type': 'application/json'
    }
  }

  const fetchCalendars = async () => {
    try {
      const headers = await getAuthHeaders()
      const response = await fetch('/api/calendars', { headers })
      if (response.ok) {
        const data = await response.json() as { calendars: Calendar[] }
        setCalendars(data.calendars || [])
      }
    } catch (error) {
      console.error('Failed to fetch calendars:', error)
    }
  }

  const fetchUpcomingEvents = async () => {
    try {
      const headers = await getAuthHeaders()
      const response = await fetch('/api/events/upcoming?limit=10', { headers })
      if (response.ok) {
        const data = await response.json() as { events: CalendarEvent[] }
        setEvents(data.events || [])
      }
    } catch (error) {
      console.error('Failed to fetch events:', error)
    }
  }

  const handleAddCalendar = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    
    try {
      const headers = await getAuthHeaders()
      const response = await fetch('/api/calendars', {
        method: 'POST',
        headers,
        body: JSON.stringify(newCalendar)
      })
      
      if (response.ok) {
        await fetchCalendars()
        await fetchUpcomingEvents()
        setShowAddForm(false)
        setNewCalendar({ name: '', url: '', refreshInterval: 60 })
      }
    } catch (error) {
      console.error('Failed to add calendar:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleDeleteCalendar = async (name: string) => {
    if (!confirm(`Delete calendar "${name}"?`)) return
    
    try {
      const headers = await getAuthHeaders()
      const response = await fetch(`/api/calendars/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers
      })
      
      if (response.ok) {
        await fetchCalendars()
        await fetchUpcomingEvents()
      }
    } catch (error) {
      console.error('Failed to delete calendar:', error)
    }
  }

  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr)
      return date.toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })
    } catch {
      return dateStr
    }
  }

  return (
    <div className="dashboard">
      <div className="dashboard-grid">
        <div className="calendars-section">
          <div className="section-header">
            <h2>📅 Calendars</h2>
            <button 
              onClick={() => setShowAddForm(!showAddForm)}
              className="add-btn"
            >
              + Add Calendar
            </button>
          </div>

          {showAddForm && (
            <form onSubmit={handleAddCalendar} className="add-calendar-form">
              <input
                type="text"
                placeholder="Calendar name"
                value={newCalendar.name}
                onChange={(e) => setNewCalendar({...newCalendar, name: e.target.value})}
                required
              />
              <input
                type="url"
                placeholder="iCal URL (https://...)"
                value={newCalendar.url}
                onChange={(e) => setNewCalendar({...newCalendar, url: e.target.value})}
                required
              />
              <div className="form-row">
                <label>
                  Refresh every:
                  <input
                    type="number"
                    min="5"
                    max="1440"
                    value={newCalendar.refreshInterval}
                    onChange={(e) => setNewCalendar({...newCalendar, refreshInterval: parseInt(e.target.value)})}
                  />
                  minutes
                </label>
              </div>
              <div className="form-actions">
                <button type="submit" disabled={isLoading}>
                  {isLoading ? 'Adding...' : 'Add Calendar'}
                </button>
                <button type="button" onClick={() => setShowAddForm(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}

          <div className="calendars-list">
            {calendars.length === 0 ? (
              <p className="empty-state">No calendars subscribed yet</p>
            ) : (
              calendars.map((calendar) => (
                <div key={calendar.name} className="calendar-card">
                  <div className="calendar-info">
                    <h3>{calendar.name}</h3>
                    <p className="calendar-url">{calendar.url}</p>
                    <div className="calendar-meta">
                      <span className={`status ${calendar.status}`}>
                        {calendar.status}
                      </span>
                      <span>Refresh: {calendar.refreshInterval}min</span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleDeleteCalendar(calendar.name)}
                    className="delete-btn"
                    title="Delete calendar"
                  >
                    🗑️
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="events-section">
          <h2>📆 Upcoming Events</h2>
          <div className="events-list">
            {events.length === 0 ? (
              <p className="empty-state">No upcoming events</p>
            ) : (
              events.map((event) => (
                <div key={event.id} className="event-card">
                  <h4>{event.summary}</h4>
                  {event.description && (
                    <p className="event-description">{event.description}</p>
                  )}
                  <div className="event-meta">
                    <span>📅 {formatDate(event.start)}</span>
                    {event.location && <span>📍 {event.location}</span>}
                    <span className="event-calendar">{event.calendarName}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="mcp-info">
        <h3>MCP Connection Info</h3>
        <div className="connection-details">
          <div>
            <strong>MCP Endpoint:</strong>
            <code>{window.location.origin}/mcp</code>
          </div>
          <div>
            <strong>SSE Endpoint (legacy):</strong>
            <code>{window.location.origin}/sse</code>
          </div>
          <div>
            <strong>Authorization URL:</strong>
            <code>{window.location.origin}/oauth/authorize</code>
          </div>
        </div>
      </div>
    </div>
  )
}

export default CalendarDashboard