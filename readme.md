# Rota Tool

This project is a web application for generating rotas for the field projects of archelon.

## TODO

- [x] Add optional column to shifts 
  - [x] Learn how to do db migration 
- [ ] Solve the tuesday/Monday bug 
- [ ] Add activate/deactivate to shifts 
- [ ] Add activate/deactivate to people 
- [ ] Add "Any Day" as an Option for shifts 
- [ ] new database model for "real" shifts, expanded from daily shifts. 
  - they are always assigned a certain date. no "any date" or "every day" 
    - they're either the result of the optimization, or they're manually added 
    - so they're not the data format that is put into the optimization algorithm, but they need to be put into
   the optimization algorithm for adding manual shifts. so they need a correspondence table to the original shifts,
   because we need to set certain variables in the algorithmic representation according to the manually added rota.
- [ ] Add slideshows + ITs + PA skills to people 
- [ ] Add animosity table, page and functionality 
- [ ] Add constraints on the optimization: 
  - [ ] Skill based constraints 
  - [ ] Animosity based constraints 
  - [ ] consider only activated shifts + people 
- [ ] Add editable rota table on manual page - this also becomes the blueprint for the auto rota 
- [ ] Some database cleaning: 
  - [ ] check skill uniqueness, remove double entries 
  - [ ] decide when to clean the database 
- [ ] Add buttons to activate/deactivate constraints: 
  - minimal number of minutes between shifts (field)
  - weights of the objectives:
    - animosity
    - number of assignments in total
    - difference in number of Morning surveys
    - No MS in a row weight (this also activates/deactivates avoiding MS in a row)
  - activate/deactivate counting the manual entries in the auto rota towards the total number of assignments
  - [ ] binarize cross-platform to a standalone .exe file
  