# routes/people.py
from flask import Blueprint, request, redirect, url_for, render_template
from datetime import datetime
import math
from sqlalchemy.exc import IntegrityError
from models import db, Person, Skill, PersonSkill
#import jsonify
from flask import jsonify

people_bp = Blueprint('people', __name__, url_prefix='/people')

# routes/people.py
@people_bp.route('/', methods=['GET'], endpoint='people')
def people():
    people = Person.query.all()
    skills = Skill.query.all()
    people_with_skills = []
    for person in people:
        person_skills = [ps.skill.name for ps in person.person_skills]
        people_with_skills.append({
            'person': person,
            'skills': person_skills
        })
    print(people_with_skills)
    return render_template('people.html', people=people_with_skills, skills=skills)

@people_bp.route('/get_person/<int:person_id>', methods=['GET'], endpoint='get_person')
def get_person(person_id):
    person = Person.query.get(person_id)
    if person:
        person_skills = [{'id': ps.skill.id, 'name': ps.skill.name} for ps in person.person_skills]
        person_data = {
            'id': person.id,
            'name': person.name,
            'start_date': person.start_date.strftime('%Y-%m-%d'),
            'leaving_date': person.leaving_date.strftime('%Y-%m-%d'),
            'leader': person.leader,
            'part_time': person.part_time,
            'days_off_past': person.days_off_past,
            'days_off_total': person.days_off_total,
            'day_off_every': person.day_off_every,
            'skills': person_skills
        }
        return jsonify(person_data)
    return jsonify({'error': 'Person not found'}), 404

# routes/people.py
@people_bp.route('/add_person', methods=['POST'], endpoint='add_person')
def add_person():
    try:
        name = request.form['name']
        start_date = datetime.strptime(request.form['start_date'], '%Y-%m-%d')
        leaving_date = datetime.strptime(request.form['leaving_date'], '%Y-%m-%d')
        day_off_every = int(request.form.get('day_off_every', "10"))

        leader = 'leader' in request.form
        part_time = 'part_time' in request.form

        days_off_total = math.ceil(float((leaving_date - start_date).days) / float(day_off_every))

        new_person = Person(
            name=name,
            start_date=start_date,
            leaving_date=leaving_date,
            leader=leader,
            part_time=part_time,
            day_off_every=day_off_every,
            days_off_past=0,
            days_off_total=days_off_total
        )
        db.session.add(new_person)
        db.session.commit()

        # Add skills
        skill_ids = request.form.getlist('skills')
        for skill_id in skill_ids:
            person_skill = PersonSkill(person_id=new_person.id, skill_id=int(skill_id))
            db.session.add(person_skill)
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return "Error: Person with this name already exists.", 400
    return redirect(url_for('people.people'))

# routes/people.py
@people_bp.route('/edit_person', methods=['POST'], endpoint='edit_person')
def edit_person():
    person_id = request.form['id']
    person = Person.query.get(person_id)

    if person:
        person.name = request.form['name']
        person.start_date = datetime.strptime(request.form['start_date'], '%Y-%m-%d')
        person.leaving_date = datetime.strptime(request.form['leaving_date'], '%Y-%m-%d')
        person.leader = 'leader' in request.form
        person.part_time = 'part_time' in request.form
        person.days_off_past = int(request.form['days_off_past'])
        person.days_off_total = int(request.form['days_off_total'])
        person.day_off_every = int(request.form['day_off_every'])

        # Update skills
        skill_ids = request.form.getlist('skills')
        person.person_skills = [PersonSkill(person_id=person.id, skill_id=int(skill_id)) for skill_id in skill_ids]

        db.session.commit()

    return redirect(url_for('people.people'))


@people_bp.route('/delete_person/<int:person_id>', methods=['POST'], endpoint='delete_person')
def delete_person(person_id):
    person = Person.query.get(person_id)
    if person:
        db.session.delete(person)
        db.session.commit()
    return redirect(url_for('people.people'))