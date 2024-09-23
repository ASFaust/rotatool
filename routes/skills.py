# routes/skills.py
from flask import Blueprint, request, redirect, url_for, render_template
from sqlalchemy.exc import IntegrityError
from models import db, Skill

skills_bp = Blueprint('skills', __name__, url_prefix='/skills')

@skills_bp.route('/', methods=['GET'], endpoint='skills')
def skills():
    skills = Skill.query.all()
    return render_template('skills.html', skills=skills)

@skills_bp.route('/add_skill', methods=['POST'], endpoint='add_skill')
def add_skill():
    try:
        name = request.form['name']
        new_skill = Skill(name=name)
        db.session.add(new_skill)
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return "Error: Skill with this name already exists.", 400
    return redirect(url_for('skills.skills'))

@skills_bp.route('/delete_skill/<int:skill_id>', methods=['POST'], endpoint='delete_skill')
def delete_skill(skill_id):
    skill = Skill.query.get(skill_id)
    if skill:
        db.session.delete(skill)
        db.session.commit()
    return redirect(url_for('skills.skills'))
