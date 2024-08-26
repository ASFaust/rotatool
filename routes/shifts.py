from flask import Blueprint, request, redirect, url_for, render_template, jsonify
from datetime import datetime
from sqlalchemy.exc import IntegrityError
from models import db, Shift, Skill, ShiftSkill

shifts_bp = Blueprint('shifts', __name__, url_prefix='/shifts')

@shifts_bp.route('/', methods=['GET'], endpoint='shifts')
def shifts():
    shifts = Shift.query.all()
    skills = Skill.query.all()
    shifts_with_skills = []
    for shift in shifts:
        shift_skills = [ss.skill.name for ss in shift.shift_skills]
        shifts_with_skills.append({
            'shift': shift,
            'skills': shift_skills
        })
    return render_template('shifts.html', shifts=shifts_with_skills, skills=skills)

@shifts_bp.route('/get_shift/<int:shift_id>', methods=['GET'], endpoint='get_shift')
def get_shift(shift_id):
    shift = Shift.query.get(shift_id)
    if shift:
        shift_skills = [{'id': ss.skill.id, 'name': ss.skill.name} for ss in shift.shift_skills]
        shift_data = {
            'id': shift.id,
            'name': shift.name,
            'day_of_the_week': shift.day_of_the_week,
            'start_time': shift.start_time.strftime('%H:%M'),
            'end_time': shift.end_time.strftime('%H:%M'),
            'type': shift.type,
            'number_of_people': shift.number_of_people,
            'skills': shift_skills
        }
        return jsonify(shift_data)
    return jsonify({'error': 'Shift not found'}), 404

@shifts_bp.route('/add_shift', methods=['POST'], endpoint='add_shift')
def add_shift():
    try:
        name = request.form['name']
        day_of_the_week = request.form['day_of_the_week']
        start_time = datetime.strptime(request.form['start_time'], '%H:%M').time()
        end_time = datetime.strptime(request.form['end_time'], '%H:%M').time()
        type = request.form['type']
        number_of_people = int(request.form['number_of_people'])

        new_shift = Shift(
            name=name,
            day_of_the_week=day_of_the_week,
            start_time=start_time,
            end_time=end_time,
            type=type,
            number_of_people=number_of_people
        )
        db.session.add(new_shift)
        db.session.commit()

        # Add skills
        skill_ids = request.form.getlist('skills')
        for skill_id in skill_ids:
            shift_skill = ShiftSkill(shift_id=new_shift.id, skill_id=int(skill_id))
            db.session.add(shift_skill)
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return "Error: Shift with this name already exists.", 400
    return redirect(url_for('shifts.shifts'))

@shifts_bp.route('/edit_shift', methods=['POST'], endpoint='edit_shift')
def edit_shift():
    shift_id = request.form['id']
    shift = Shift.query.get(shift_id)

    if shift:
        shift.name = request.form['name']
        shift.day_of_the_week = request.form['day_of_the_week']
        shift.start_time = datetime.strptime(request.form['start_time'], '%H:%M').time()
        shift.end_time = datetime.strptime(request.form['end_time'], '%H:%M').time()
        shift.type = request.form['type']
        shift.number_of_people = int(request.form['number_of_people'])

        # Update skills
        skill_ids = request.form.getlist('skills')
        shift.shift_skills = [ShiftSkill(shift_id=shift.id, skill_id=int(skill_id)) for skill_id in skill_ids]

        db.session.commit()

    return redirect(url_for('shifts.shifts'))