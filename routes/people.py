# routes/people.py
from flask import Blueprint, request, redirect, url_for, render_template, jsonify
from datetime import datetime
import math
from sqlalchemy.exc import IntegrityError
from models import db, Person, Skill, PersonSkill

people_bp = Blueprint('people', __name__, url_prefix='/people')


@people_bp.route('/', methods=['GET'], endpoint='people')
def people():
    people = Person.query.order_by(Person.leader.desc(), Person.leaving_date.desc()).all()
    skills = Skill.query.order_by(Skill.name).all()
    people_with_skills = []
    for person in people:
        person_skills = [ps.skill.name for ps in sorted(person.person_skills, key=lambda ps: ps.skill.name)]
        people_with_skills.append({
            'person': person,
            'skills': person_skills
        })
    return render_template('people.html', people=people_with_skills, skills=skills)


@people_bp.route('/add_person', methods=['POST'], endpoint='add_person')
def add_person():
    if request.is_json:
        data = request.get_json()
        try:
            name = data['name']
            start_date = datetime.strptime(data['start_date'], '%Y-%m-%d')
            leaving_date = datetime.strptime(data['leaving_date'], '%Y-%m-%d')
            leader = data.get('leader', False)
            part_time = data.get('part_time', False)
            skills = data.get('skills', [])
            # Assuming 'activated' is always True when adding a new person
            activated = True

            day_off_every = 10  # Default value or adjust as needed
            days_off_total = math.ceil(float((leaving_date - start_date).days) / float(day_off_every))

            new_person = Person(
                name=name,
                start_date=start_date,
                leaving_date=leaving_date,
                leader=leader,
                part_time=part_time,
                day_off_every=day_off_every,
                days_off_past=0,
                days_off_total=days_off_total,
                activated=activated
            )
            db.session.add(new_person)
            db.session.commit()

            # Add skills
            for skill_id in skills:
                skill = Skill.query.get(int(skill_id))
                if skill:
                    person_skill = PersonSkill(person_id=new_person.id, skill_id=skill.id)
                    db.session.add(person_skill)
            db.session.commit()

            # Return success response with the new person's data
            person_skills = [skill.name for skill in new_person.skills]
            person_data = {
                'id': new_person.id,
                'name': new_person.name,
                'start_date': new_person.start_date.strftime('%Y-%m-%d'),
                'leaving_date': new_person.leaving_date.strftime('%Y-%m-%d'),
                'leader': new_person.leader,
                'part_time': new_person.part_time,
                'skills': person_skills,
                'activated': new_person.activated
            }
            return jsonify({'message': 'Person added successfully.', 'person': person_data}), 201

        except KeyError as e:
            return jsonify({'error': f'Missing field: {str(e)}'}), 400
        except IntegrityError:
            db.session.rollback()
            return jsonify({'error': 'Person with this name already exists.'}), 400
        except Exception as e:
            db.session.rollback()
            return jsonify({'error': str(e)}), 500
    else:
        # Fallback to form submission if not JSON
        try:
            name = request.form['name']
            start_date = datetime.strptime(request.form['start_date'], '%Y-%m-%d')
            leaving_date = datetime.strptime(request.form['leaving_date'], '%Y-%m-%d')
            day_off_every = int(request.form.get('day_off_every', "10"))
            leader = 'leader' in request.form
            part_time = 'part_time' in request.form
            activated = 'activated' in request.form

            days_off_total = math.ceil(float((leaving_date - start_date).days) / float(day_off_every))

            new_person = Person(
                name=name,
                start_date=start_date,
                leaving_date=leaving_date,
                leader=leader,
                part_time=part_time,
                day_off_every=day_off_every,
                days_off_past=0,
                days_off_total=days_off_total,
                activated=activated
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


@people_bp.route('/edit_person/<int:person_id>', methods=['POST'], endpoint='edit_person')
def edit_person(person_id):
    if request.is_json:
        data = request.get_json()
        person = Person.query.get(person_id)

        if person:
            try:
                person.name = data['name']
                person.start_date = datetime.strptime(data['start_date'], '%Y-%m-%d')
                person.leaving_date = datetime.strptime(data['leaving_date'], '%Y-%m-%d')
                person.leader = data.get('leader', False)
                person.part_time = data.get('part_time', False)

                # Update skills
                skills = data.get('skills', [])
                # Remove existing skills
                PersonSkill.query.filter_by(person_id=person.id).delete()
                # Add new skills
                for skill_id in skills:
                    skill = Skill.query.get(int(skill_id))
                    if skill:
                        person_skill = PersonSkill(person_id=person.id, skill_id=skill.id)
                        db.session.add(person_skill)

                db.session.commit()

                # Return success response
                person_skills = [skill.name for skill in person.skills]
                person_data = {
                    'id': person.id,
                    'name': person.name,
                    'start_date': person.start_date.strftime('%Y-%m-%d'),
                    'leaving_date': person.leaving_date.strftime('%Y-%m-%d'),
                    'leader': person.leader,
                    'part_time': person.part_time,
                    'skills': person_skills,
                    'activated': person.activated
                }
                return jsonify({'message': 'Person updated successfully.', 'person': person_data}), 200

            except KeyError as e:
                return jsonify({'error': f'Missing field: {str(e)}'}), 400
            except Exception as e:
                db.session.rollback()
                return jsonify({'error': str(e)}), 500
        else:
            return jsonify({'error': 'Person not found.'}), 404
    else:
        # Fallback to form submission if not JSON
        person = Person.query.get(person_id)

        if person:
            try:
                person.name = request.form['name']
                person.start_date = datetime.strptime(request.form['start_date'], '%Y-%m-%d')
                person.leaving_date = datetime.strptime(request.form['leaving_date'], '%Y-%m-%d')
                person.leader = 'leader' in request.form
                person.part_time = 'part_time' in request.form
                person.days_off_past = int(request.form.get('days_off_past', person.days_off_past))
                person.days_off_total = int(request.form.get('days_off_total', person.days_off_total))
                person.day_off_every = int(request.form.get('day_off_every', person.day_off_every))
                person.activated = 'activated' in request.form

                # Update skills
                skill_ids = request.form.getlist('skills')
                person.person_skills = [PersonSkill(person_id=person.id, skill_id=int(skill_id)) for skill_id in skill_ids]

                db.session.commit()
            except Exception as e:
                db.session.rollback()
                return f"Error: {str(e)}", 400

        return redirect(url_for('people.people'))


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
            'skills': person_skills,
            'activated': person.activated
        }
        return jsonify(person_data)
    return jsonify({'error': 'Person not found'}), 404


@people_bp.route('/delete_person/<int:person_id>', methods=['POST'], endpoint='delete_person')
def delete_person(person_id):
    person = Person.query.get(person_id)
    if person:
        db.session.delete(person)
        db.session.commit()
        return jsonify({'message': 'Person deleted successfully.'}), 200
    return jsonify({'error': 'Person not found.'}), 404


# New routes for activating and deactivating people
@people_bp.route('/activate_person/<int:person_id>', methods=['POST'], endpoint='activate_person')
def activate_person(person_id):
    person = Person.query.get(person_id)
    if person:
        person.activated = True
        db.session.commit()
        return jsonify({'message': 'Person activated successfully.'}), 200
    return jsonify({'error': 'Person not found.'}), 404


@people_bp.route('/deactivate_person/<int:person_id>', methods=['POST'], endpoint='deactivate_person')
def deactivate_person(person_id):
    person = Person.query.get(person_id)
    if person:
        person.activated = False
        db.session.commit()
        return jsonify({'message': 'Person deactivated successfully.'}), 200
    return jsonify({'error': 'Person not found.'}), 404
