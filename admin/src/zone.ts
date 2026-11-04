import { createContext, useContext } from 'react'

// The school's time zone, as the session names it. Every time the pages show is read on the school's clock, wherever
// the computer looking at them is. Outside a session (a page shown on its own) it is this computer's zone.

export const SchoolZone = createContext(Intl.DateTimeFormat().resolvedOptions().timeZone)

export const useSchoolZone = () => useContext(SchoolZone)
